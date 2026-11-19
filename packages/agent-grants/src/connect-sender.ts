// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/connect-sender`
 * Purpose: The CUSTOMER side of connect from home (story.0038, 0.9.0), shared by every node: list the providers a node's `.cogni/service-links.yaml` names as targets with this node's own
 *   connection state (status and cap), and sign and send one connect or disconnect with this node's signer. The provider's answer comes back as it is.
 * Scope: Pure over three injected parts: the signer (`ServiceAssertionSigner`), an `OutboundConnectionStore` (the seq and the node's own state; a Postgres adapter is exported over a service-role
 *   tag) and `fetch`. No routes, no env, no logging (an `onSent` hook carries the facts a node logs). The caller (an admin route behind the one admin check) owns who may ask.
 * Invariants:
 *   - ALIAS_FROM_SERVER_CONFIG: an alias that is not a configured target is refused before any signing or network call; the alias is never a URL.
 *   - NO_SIGNER_NO_CALL: without a signing key nothing is sent (`no_signer`) and no seq is taken.
 *   - SEQ_RISES_ACROSS_RESTARTS: the next `seq` is taken by ONE atomic store call BEFORE signing, so a restart, a second replica or a failed send never reuses one. A provider's `stale_seq` or
 *     `seq_jump` answer carries its stored seq: after `stale_seq` this node rises above it (`liftSeq`, a `GREATEST`); after `seq_jump` (the provider admin reset the record, so the provider's seq is
 *     far BELOW ours) it aligns to it exactly (`alignSeq`), so one click later the connect lands in both cases.
 *   - STATE_IS_MY_OWN_ACT: status and cap are written only from a provider 200, and only while no newer send has reserved a higher seq (`accept` is guarded by the reserved seq), so a slow
 *     answer never overwrites a newer one. A refusal changes neither.
 *   - FIXED_POST: one POST to `{origin}/api/v1/public/agent/service-connections` on the configured origin only, https, no redirects, 10 s, 64 KiB cap, body `{}` (the signed claims are the request).
 *   - NO_TOKEN_ANYWHERE: `onSent` carries alias, act, the provider's status and HTTP status, never an assertion, a header or a body; the provider's `error` returned is a short code or null.
 * Side-effects: IO (the store; one signed HTTPS POST to a configured node)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design, migrations/outbound_connections.sql
 * @public
 */

import { CONNECT_SCOPE } from "./connections";
import type { SqlTag } from "./postgres";
import { type LinkTarget, NODE_CONNECT_SERVICE, type ServiceAssertionSigner } from "./service-auth";

const SEND_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 64 * 1024;
export const CONNECT_PATH = "/api/v1/public/agent/service-connections";
const ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/** One configured provider as the customer's page shows it, with this node's own connection state. */
export interface OutboundTargetView {
  readonly alias: string;
  readonly origin: string;
  /** Static offer text from this node's own config; the provider is never asked. */
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
      /** The provider's HTTP status. */
      readonly httpStatus: number;
      /** The provider's answer: the record's status after the call, or null when it refused. */
      readonly status: "connected" | "disconnected" | null;
      /** The provider's plain refusal code, or null. */
      readonly error: string | null;
      readonly target: OutboundTargetView;
    }
  | { readonly ok: false; readonly reason: "unknown_alias" | "no_signer" | "unreachable" };

/** This node's own memory of what it last told one provider. */
export interface OutboundState {
  readonly status: "connected" | "disconnected";
  readonly cap: number;
  readonly seq: number;
}

/** Persistence port for this node's own side. Node-local rows: one per provider origin. */
export interface OutboundConnectionStore {
  /** Atomically takes the next seq for `origin` (a first row starts at 1 with status `disconnected`, cap 0) and returns it with the cap this node last had accepted. */
  reserveSeq(origin: string): Promise<{ seq: number; cap: number }>;
  /** The states of these origins; an origin never sent to is absent. */
  states(origins: readonly string[]): Promise<ReadonlyMap<string, OutboundState>>;
  /** Records the provider's acceptance, only while `reservedSeq` is still the stored seq or above it (a newer send has not overtaken it). */
  accept(input: { origin: string; status: "connected" | "disconnected"; cap: number; reservedSeq: number }): Promise<void>;
  /** Raises the stored seq to at least `seq` (the provider's stored one, after a `stale_seq`). Never lowers it. */
  liftSeq(origin: string, seq: number): Promise<void>;
  /** Sets the stored seq to exactly `seq` (the provider's stored one, after a `seq_jump`): the provider's admin reset it, so this node's higher local seq would be refused forever. */
  alignSeq(origin: string, seq: number): Promise<void>;
}

export interface ConnectSender {
  /** The configured targets with this node's own state; `signer` is false when this node has no signing key. */
  list(): Promise<{ signer: boolean; targets: OutboundTargetView[] }>;
  /** Signs and sends one connect (with `cap`) or disconnect to the target `alias` names, and returns the provider's answer. */
  act(input: { alias: string; act: "connect"; cap: number } | { alias: string; act: "disconnect" }): Promise<OutboundActResult>;
}

/** A body read with a hard byte cap; null when it is empty, over the cap or unreadable. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(maxBytes);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(bytes.subarray(0, total));
}

export function createConnectSender(deps: {
  /** The nodes this deployment may call, from `.cogni/service-links.yaml` (`parseLinkTargets`). */
  readonly targets: readonly LinkTarget[];
  /** Read lazily: a node builds its signer after the sender's wiring. Null = this node has no signing key. */
  readonly signer: () => Promise<ServiceAssertionSigner | null>;
  readonly store: OutboundConnectionStore;
  readonly fetchImpl?: typeof fetch;
  /** Called once per send with the facts a node logs. Never carries an assertion, a header or a body. */
  readonly onSent?: (event: { alias: string; act: "connect" | "disconnect"; outcome: "unreachable" | "answered"; httpStatus?: number; status?: "connected" | "disconnected" | null }) => void;
}): ConnectSender {
  const byAlias = new Map(deps.targets.map((t) => [t.alias, t]));
  const doFetch = deps.fetchImpl ?? fetch;

  const viewOf = (target: LinkTarget, state: OutboundState | undefined): OutboundTargetView => {
    const connected = state?.status === "connected";
    return {
      alias: target.alias,
      origin: target.origin,
      ...(target.offer ? { offer: target.offer } : {}),
      status: connected ? "connected" : "not_connected",
      cap: connected ? state.cap : null,
    };
  };

  return {
    async list() {
      const signer = (await deps.signer()) !== null;
      const states = deps.targets.length === 0 ? new Map<string, OutboundState>() : await deps.store.states(deps.targets.map((t) => t.origin));
      return { signer, targets: deps.targets.map((t) => viewOf(t, states.get(t.origin))) };
    },

    async act(input) {
      const target = byAlias.get(input.alias);
      if (!target) return { ok: false, reason: "unknown_alias" };
      const signer = await deps.signer();
      if (!signer) return { ok: false, reason: "no_signer" };

      const reserved = await deps.store.reserveSeq(target.origin);
      // A disconnect keeps the provider's stored cap, so it signs the cap this node last had accepted.
      const cap = input.act === "connect" ? input.cap : reserved.cap;

      let response: Response;
      try {
        const authorization = await signer.authorizationHeader({
          service: NODE_CONNECT_SERVICE,
          audienceNodeId: target.nodeId,
          scope: CONNECT_SCOPE,
          claims: { act: input.act, cap, seq: reserved.seq },
        });
        response = await doFetch(new URL(CONNECT_PATH, target.origin).href, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", authorization },
          body: "{}",
          redirect: "manual",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        deps.onSent?.({ alias: target.alias, act: input.act, outcome: "unreachable" });
        return { ok: false, reason: "unreachable" };
      }

      let answer: { status?: unknown; cap?: unknown; seq?: unknown; error?: unknown } = {};
      try {
        const parsed: unknown = JSON.parse((await readCapped(response, MAX_ANSWER_BYTES)) ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answer = parsed as typeof answer;
      } catch {
        answer = {};
      }

      const status = response.ok && (answer.status === "connected" || answer.status === "disconnected") ? answer.status : null;
      const error = !response.ok && typeof answer.error === "string" && ERROR_CODE.test(answer.error) ? answer.error : null;
      if (status) {
        await deps.store.accept({
          origin: target.origin,
          status,
          cap: status === "connected" && typeof answer.cap === "number" && Number.isSafeInteger(answer.cap) ? answer.cap : cap,
          reservedSeq: reserved.seq,
        });
      } else if (response.status === 409 && (error === "stale_seq" || error === "seq_jump") && Number.isSafeInteger(answer.seq) && (answer.seq as number) >= 0) {
        // STALE: the provider holds a higher seq (this node's table was reset or restored): rise above it, so the next click lands.
        // JUMP: the provider holds a much LOWER seq (its admin reset the record): align to it exactly, or a local seq above the step bound is refused forever.
        if (error === "seq_jump") await deps.store.alignSeq(target.origin, answer.seq as number);
        else await deps.store.liftSeq(target.origin, answer.seq as number);
      }
      deps.onSent?.({ alias: target.alias, act: input.act, outcome: "answered", httpStatus: response.status, status });
      const states = await deps.store.states([target.origin]);
      return { ok: true, alias: target.alias, act: input.act, httpStatus: response.status, status, error, target: viewOf(target, states.get(target.origin)) };
    },
  };
}

const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

/** The Postgres adapter over a service-role tag (`outbound_connections` has no policy). Each method is one statement. */
export function createPostgresOutboundConnectionStore(sql: SqlTag): OutboundConnectionStore {
  return {
    async reserveSeq(origin) {
      const rows = await sql`
        INSERT INTO outbound_connections (target_origin, status, cap, seq) VALUES (${origin}, 'disconnected', 0, 1)
        ON CONFLICT (target_origin) DO UPDATE SET seq = outbound_connections.seq + 1, updated_at = now()
        RETURNING seq::text AS seq, cap::text AS cap`;
      return { seq: num(rows[0]?.seq), cap: num(rows[0]?.cap) };
    },
    async states(origins) {
      const rows = await sql`SELECT target_origin, status, cap::text AS cap, seq::text AS seq FROM outbound_connections WHERE target_origin = ANY(${[...origins]})`;
      const out = new Map<string, OutboundState>();
      for (const row of rows) {
        const origin = typeof row.target_origin === "string" ? row.target_origin : null;
        if (origin && (row.status === "connected" || row.status === "disconnected")) out.set(origin, { status: row.status, cap: num(row.cap), seq: num(row.seq) });
      }
      return out;
    },
    async accept({ origin, status, cap, reservedSeq }) {
      // GUARDED: a newer send holds a higher seq, and its answer, not this slower one, decides the state.
      await sql`
        UPDATE outbound_connections SET status = ${status}, cap = ${cap}, updated_at = now()
        WHERE target_origin = ${origin} AND seq <= ${reservedSeq}`;
    },
    async alignSeq(origin, seq) {
      await sql`UPDATE outbound_connections SET seq = ${seq}, updated_at = now() WHERE target_origin = ${origin}`;
    },
    async liftSeq(origin, seq) {
      await sql`UPDATE outbound_connections SET seq = GREATEST(seq, ${seq}), updated_at = now() WHERE target_origin = ${origin}`;
    },
  };
}
