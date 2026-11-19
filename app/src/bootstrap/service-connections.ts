// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/service-connections`
 * Purpose: This node as a CUSTOMER in connect from home (story.0038, 0.9.0): list the providers `.cogni/service-links.yaml` names as targets with this node's own connection state
 *   (status and cap), and sign and send one connect or disconnect with this node's signer. The provider's answer comes back as it is.
 * Scope: Composition only. The claims, the signer, the verifier and the provider's decisions are in `@cogni/agent-grants`. The caller (an admin route behind the one admin check) owns who may ask.
 * Invariants:
 *   - ALIAS_FROM_SERVER_CONFIG: an alias that is not a configured target is refused before any signing or network call; the alias is never a URL.
 *   - NO_SIGNER_NO_CALL: without a signing key nothing is sent (`no_signer`); the page shows "this node has no signing key".
 *   - SEQ_RISES_ACROSS_RESTARTS: the next `seq` is taken by ONE atomic update of `outbound_connections` BEFORE signing, so a restart, a second replica or a failed send never reuses one. A provider's
 *     `stale_seq` answer carries its stored seq and this node rises above it (`GREATEST`), so one click later the connect lands.
 *   - STATE_IS_MY_OWN_ACT: status and cap are written only from a provider 200 (the provider accepted). A refusal changes neither.
 *   - FIXED_POST: one POST to `{origin}/api/v1/public/agent/service-connections` on the configured origin, https, no redirects, 10 s, 64 KiB cap, body `{}` (the signed claims are the request).
 *   - NO_TOKEN_IN_LOGS: `connection.sent` carries alias, act and the provider's status, never an assertion, a header or a body. The provider's `error` shown is a short code or nothing.
 * Side-effects: IO (service-role database reads and writes; one signed HTTPS POST to a configured node)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

import { CONNECT_SCOPE } from "@cogni/agent-grants";
import { type LinkTarget, NODE_CONNECT_SERVICE, type ServiceAssertionSigner } from "@cogni/agent-grants/service-auth";
import { readBodyCapped } from "@cogni/ai-tools";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";
import type { AgentAuthoritySql } from "./agent-authority";

const SEND_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 64 * 1024;
const CONNECT_PATH = "/api/v1/public/agent/service-connections";
const ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/;

export interface OutboundTargetView {
  readonly alias: string;
  readonly origin: string;
  readonly offer?: string;
  /** What this node last asked and the provider accepted. `not_connected` also covers a disconnect. */
  readonly status: "connected" | "not_connected";
  /** The cap the provider last accepted, or null when not connected. */
  readonly cap: number | null;
}

export type OutboundActResult =
  | {
      readonly ok: true;
      readonly alias: string;
      readonly act: "connect" | "disconnect";
      readonly httpStatus: number;
      readonly status: "connected" | "disconnected" | null;
      readonly error: string | null;
      readonly target: OutboundTargetView;
    }
  | { readonly ok: false; readonly reason: "unknown_alias" | "no_signer" | "unreachable" };

export interface ServiceConnections {
  /** The configured targets with this node's own state; `signer` is false when this node has no signing key. */
  list(): Promise<{ signer: boolean; targets: OutboundTargetView[] }>;
  /** Signs and sends one connect (with `cap`) or disconnect to the target `alias` names, and returns the provider's answer. */
  act(input: { alias: string; act: "connect"; cap: number } | { alias: string; act: "disconnect" }): Promise<OutboundActResult>;
}

const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

export function createServiceConnections(deps: {
  /** The nodes this deployment may call, from `.cogni/service-links.yaml`. */
  readonly targets: readonly LinkTarget[];
  /** Read lazily: the signer is built with `serviceAuth`, after this. */
  readonly signer: () => Promise<ServiceAssertionSigner | null>;
  readonly sql: AgentAuthoritySql;
  readonly log: Logger;
  readonly fetchImpl?: typeof fetch;
}): ServiceConnections {
  const byAlias = new Map(deps.targets.map((t) => [t.alias, t]));
  const doFetch = deps.fetchImpl ?? fetch;

  const viewOf = (target: LinkTarget, row: Record<string, unknown> | undefined): OutboundTargetView => {
    const connected = row?.status === "connected";
    return {
      alias: target.alias,
      origin: target.origin,
      ...(target.offer ? { offer: target.offer } : {}),
      status: connected ? "connected" : "not_connected",
      cap: connected ? num(row?.cap) : null,
    };
  };

  const rowOf = async (target: LinkTarget): Promise<Record<string, unknown> | undefined> =>
    (await deps.sql`SELECT status, cap::text AS cap FROM outbound_connections WHERE target_origin = ${target.origin} LIMIT 1`)[0];

  return {
    async list() {
      const signer = (await deps.signer()) !== null;
      const origins = deps.targets.map((t) => t.origin);
      const rows =
        origins.length === 0
          ? []
          : ((await deps.sql`SELECT target_origin, status, cap::text AS cap FROM outbound_connections WHERE target_origin = ANY(${origins})`) as ReadonlyArray<Record<string, unknown>>);
      const byOrigin = new Map(rows.map((r) => [r.target_origin as string, r]));
      return { signer, targets: deps.targets.map((t) => viewOf(t, byOrigin.get(t.origin))) };
    },

    async act(input) {
      const target = byAlias.get(input.alias);
      if (!target) return { ok: false, reason: "unknown_alias" };
      const signer = await deps.signer();
      if (!signer) return { ok: false, reason: "no_signer" };

      // SEQ_RISES_ACROSS_RESTARTS: take the next seq atomically BEFORE signing. A first-ever row starts at 1.
      const reserved = (
        await deps.sql`
          INSERT INTO outbound_connections (target_origin, status, cap, seq) VALUES (${target.origin}, 'disconnected', 0, 1)
          ON CONFLICT (target_origin) DO UPDATE SET seq = outbound_connections.seq + 1, updated_at = now()
          RETURNING seq::text AS seq, cap::text AS cap`
      )[0];
      const seq = num(reserved?.seq);
      // A disconnect keeps the provider's stored cap, so it signs the cap this node last had accepted.
      const cap = input.act === "connect" ? input.cap : num(reserved?.cap);

      let response: Response;
      try {
        const authorization = await signer.authorizationHeader({
          service: NODE_CONNECT_SERVICE,
          audienceNodeId: target.nodeId,
          scope: CONNECT_SCOPE,
          claims: { act: input.act, cap, seq },
        });
        response = await doFetch(new URL(CONNECT_PATH, target.origin).href, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", authorization },
          body: "{}",
          redirect: "manual",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        deps.log.warn({ event: EVENT_NAMES.CONNECTION_SENT, alias: target.alias, act: input.act, outcome: "unreachable" }, EVENT_NAMES.CONNECTION_SENT);
        return { ok: false, reason: "unreachable" };
      }

      let answer: { status?: unknown; cap?: unknown; seq?: unknown; error?: unknown } = {};
      try {
        const text = await readBodyCapped(response, MAX_ANSWER_BYTES);
        const parsed: unknown = JSON.parse(text ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answer = parsed as typeof answer;
      } catch {
        answer = {};
      }

      const status = response.ok && (answer.status === "connected" || answer.status === "disconnected") ? answer.status : null;
      const error = !response.ok && typeof answer.error === "string" && ERROR_CODE.test(answer.error) ? answer.error : null;
      if (status) {
        // STATE_IS_MY_OWN_ACT: only the provider's 200 moves this node's status and cap.
        await deps.sql`
          UPDATE outbound_connections SET status = ${status}, cap = ${status === "connected" ? num(answer.cap) : cap}, updated_at = now() WHERE target_origin = ${target.origin}`;
      } else if (response.status === 409 && error === "stale_seq" && Number.isSafeInteger(answer.seq) && (answer.seq as number) >= 0) {
        // The provider already holds a higher seq (this node's table was reset or restored): rise above it, so the next click lands.
        await deps.sql`UPDATE outbound_connections SET seq = GREATEST(seq, ${answer.seq as number}) WHERE target_origin = ${target.origin}`;
      }
      deps.log.info(
        { event: EVENT_NAMES.CONNECTION_SENT, alias: target.alias, act: input.act, httpStatus: response.status, status },
        EVENT_NAMES.CONNECTION_SENT
      );
      return { ok: true, alias: target.alias, act: input.act, httpStatus: response.status, status, error, target: viewOf(target, await rowOf(target)) };
    },
  };
}
