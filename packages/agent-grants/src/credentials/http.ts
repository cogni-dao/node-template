// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` http
 * Purpose: The fleet's ONE wire contract for the revocable key routes (upgrade, rotate, confirm, revoke) and the ONE mapping from a service
 *   result or error to an HTTP status, body and headers. A node's Next route files call it and keep only auth, parsing and the response object.
 * Scope: Framework-free. Returns `{ status, body, headers }`; builds no `Response`, reads no request, logs nothing. Agents call these
 *   routes on every node, so a node that typed the codes by hand would drift from the others.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: every 2xx body is parsed through its zod shape. `apiKey` is returned once by upgrade and rotate, never again.
 *   - FAIL_CLOSED_NON_DISCLOSING: a missing, forged, revoked, expired or wrong-state key is the same 401 `invalid_token`.
 *   - STORE_OUTAGE_IS_NOT_401: a store failure is 503 `authz_unavailable` with `retry-after`, never 401 or 500.
 *   - OVER_LIMIT_IS_429: 429 `rate_limited` with `retry-after: 60`.
 *   - NEVER_CACHED: every response carries `cache-control: no-store`.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5474
 * @public
 */

import { z } from "zod";

import {
  CredentialRateLimitedError,
  CredentialStoreUnavailableError,
  type MintedKey,
  V1SupersededError,
  type VerifyResult,
} from "./service";
import type { ConfirmResult } from "./types";

const pendingKey = z.object({
  userId: z.string().min(1),
  credentialId: z.string().min(1),
  /** The key. Shown once. Format: `key-format.ts`. */
  apiKey: z.string().min(1),
  status: z.literal("pending"),
  pendingExpiresAt: z.string().min(1),
});

export const upgradeAgentCredentialOperation = { id: "agent.credentials.upgrade", output: pendingKey } as const;
export const rotateAgentCredentialOperation = { id: "agent.credentials.rotate", output: pendingKey } as const;

export const confirmAgentCredentialOperation = {
  id: "agent.credentials.confirm",
  output: z.object({
    userId: z.string().min(1),
    credentialId: z.string().min(1),
    status: z.literal("active"),
    /** True when the credential was already active (a replayed confirm). */
    replay: z.boolean(),
    expiresAt: z.string().min(1),
    renewUntil: z.string().min(1),
  }),
} as const;

export const revokeAgentCredentialOperation = {
  id: "agent.credentials.revoke",
  /** Omit `credentialId` to revoke the key that made the call. */
  input: z.object({ credentialId: z.string().uuid().optional() }),
  output: z.object({ credentialId: z.string().min(1), revoked: z.literal(true) }),
} as const;

/** A framework-free HTTP answer. `refusal` is the machine code of a non-2xx answer, for the node's log line. */
export interface CredentialHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly refusal?: string;
}

const NO_STORE = { "cache-control": "no-store" } as const;
const BEARER_INVALID = { ...NO_STORE, "www-authenticate": 'Bearer error="invalid_token"' } as const;

const ok = (body: Record<string, unknown>): CredentialHttpResponse => ({ status: 200, body, headers: NO_STORE });
const refuse = (status: number, error: string, headers: Readonly<Record<string, string>> = NO_STORE): CredentialHttpResponse => ({
  status,
  body: { error },
  headers,
  refusal: error,
});

const UPGRADE_REFUSALS = {
  unknown_user: [403, "not_agent_key"],
  wallet_user: [403, "not_agent_key"],
  internal_principal: [403, "not_agent_key"],
  not_rotatable: [409, "not_rotatable"],
  already_upgraded: [409, "already_upgraded"],
  binding_required: [409, "binding_required"],
} as const;

const CONFIRM_REFUSALS = {
  revoked: "superseded",
  expired: "pending_expired",
  predecessor_revoked: "predecessor_revoked",
  not_found: "superseded",
  binding_required: "binding_required",
} as const;

export type CredentialHttpInput =
  | { readonly op: "upgrade"; readonly result: MintedKey }
  | { readonly op: "rotate"; readonly result: MintedKey }
  | { readonly op: "confirm"; readonly credentialId: string; readonly result: ConfirmResult }
  | { readonly op: "revoke"; readonly credentialId: string; readonly revoked: boolean }
  /** upgrade was called with a session or a revocable key instead of a signed key. */
  | { readonly op: "signed_key_required" }
  /** the revoke body failed `revokeAgentCredentialOperation.input`. */
  | { readonly op: "invalid_input" };

/** The answer for the result of a credential route operation. */
export function credentialHttp(input: CredentialHttpInput): CredentialHttpResponse {
  switch (input.op) {
    case "signed_key_required":
      return refuse(403, "signed_key_required");
    case "invalid_input":
      return refuse(400, "invalid input");
    case "upgrade":
    case "rotate": {
      const minted = input.result;
      if (!minted.ok) {
        // Rotate has one refusal; upgrade names each one.
        const [status, error] = input.op === "rotate" ? ([409, "not_rotatable"] as const) : UPGRADE_REFUSALS[minted.reason];
        return refuse(status, error);
      }
      const shape = input.op === "upgrade" ? upgradeAgentCredentialOperation : rotateAgentCredentialOperation;
      return ok(
        shape.output.parse({
          userId: minted.userId,
          credentialId: minted.credentialId,
          apiKey: minted.apiKey,
          status: "pending",
          pendingExpiresAt: minted.pendingExpiresAt,
        })
      );
    }
    case "confirm": {
      const result = input.result;
      if (!result.ok) return refuse(409, CONFIRM_REFUSALS[result.reason]);
      return ok(
        confirmAgentCredentialOperation.output.parse({
          userId: result.userId,
          credentialId: input.credentialId,
          status: "active",
          replay: result.status === "already_active",
          expiresAt: result.expiresAt,
          renewUntil: result.renewUntil,
        })
      );
    }
    case "revoke":
      return input.revoked
        ? ok(revokeAgentCredentialOperation.output.parse({ credentialId: input.credentialId, revoked: true }))
        : refuse(404, "not_found");
  }
}

/** The answer when a revocable key did not authenticate. `ok: true` never reaches here. */
export function credentialDenialHttp(reason: Extract<VerifyResult, { ok: false }>["reason"]): CredentialHttpResponse {
  if (reason === "unavailable") return refuse(503, "authz_unavailable", { ...NO_STORE, "retry-after": "5" });
  if (reason === "rate_limited") return refuse(429, "rate_limited", { ...NO_STORE, "retry-after": "60" });
  return refuse(401, "invalid_token", BEARER_INVALID);
}

/** The answer for a typed error thrown while resolving a key, or null when the error is not one of ours (the caller rethrows it). */
export function credentialErrorHttp(error: unknown): CredentialHttpResponse | null {
  if (error instanceof V1SupersededError) return refuse(401, error.code, BEARER_INVALID);
  if (error instanceof CredentialRateLimitedError) return credentialDenialHttp("rate_limited");
  if (error instanceof CredentialStoreUnavailableError) return credentialDenialHttp("unavailable");
  return null;
}
