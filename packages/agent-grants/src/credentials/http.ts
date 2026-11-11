// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` http
 * Purpose: The fleet's ONE wire contract for the revocable key routes (upgrade, rotate, confirm, revoke) and the ONE mapping from a service
 *   result or error to an HTTP status, body and headers. A node's Next route files call it and keep only auth, parsing and the response object.
 * Scope: Framework-free. Returns `{ status, body, headers }`; builds no `Response`, reads no request, logs nothing. Agents call these
 *   routes on every node, so a node that typed the codes by hand would drift from the others.
 *   Also the proof routes (task.0091): proof challenge, bind GitHub, recover, revoke-principal (stop), lift-stop.
 * Invariants:
 *   - PROOF_FAILURES_ARE_422: a comment that does not prove (`proof_failed`) is 422 with a `reason` from a fixed set. A wrong, unknown, consumed,
 *     expired or dead challenge is ONE 401 `invalid_challenge`. GitHub down or a spent budget is 503 `proof_unavailable`, and consumes nothing.
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
  type BindOutcome,
  type ChallengeOutcome,
  CredentialRateLimitedError,
  CredentialStoreUnavailableError,
  type LiftOutcome,
  type MintedKey,
  type RecoverOutcome,
  type StopOutcome,
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

const challengeOutput = z.object({
  challengeId: z.string().uuid(),
  /** The public line to post as a comment on one of `issues`. Holds no secret. */
  proofLine: z.string().min(1),
  /** Shown once. Every use of the challenge must present it. */
  challengeSecret: z.string().min(1),
  expiresAt: z.string().min(1),
  /** `owner/repo#number` entries: post the comment on one of them. */
  issues: z.array(z.string().min(1)).min(1),
});

export const proofChallengeOperation = {
  id: "agent.proofs.challenge",
  input: z.object({ purpose: z.enum(["bind", "recover"]) }).strict(),
  output: challengeOutput,
} as const;

const proofAttemptInput = z
  .object({
    challengeId: z.string().uuid(),
    challengeSecret: z.string().min(1).max(200),
    issue: z.string().min(1).max(200),
    commentId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const bindGithubOperation = {
  id: "agent.bindings.github",
  input: proofAttemptInput,
  output: z.object({
    bound: z.literal(true),
    githubId: z.string().min(1),
    userType: z.enum(["User", "Bot"]),
    result: z.enum(["created", "already_bound"]),
  }),
} as const;

export const recoverCredentialOperation = {
  id: "agent.credentials.recover",
  input: proofAttemptInput,
  output: z.object({
    userId: z.string().min(1),
    credentialId: z.string().min(1),
    /** The new key. Shown once. */
    apiKey: z.string().min(1),
    status: z.literal("active"),
    expiresAt: z.string().min(1),
    renewUntil: z.string().min(1),
  }),
} as const;

export const revokePrincipalOperation = {
  id: "agent.credentials.revoke_principal",
  input: z.object({ principalUserId: z.string().min(1).max(100) }).strict(),
  output: z.object({ revoked: z.number().int().min(0) }),
} as const;

export const liftStopOperation = {
  id: "agent.credentials.lift_stop",
  input: z.object({ principalUserId: z.string().min(1).max(100) }).strict(),
  output: z.object({ lifted: z.literal(true) }),
} as const;

/** A framework-free HTTP answer. `refusal` is the machine code of a non-2xx answer, for the node's log line. */
export interface CredentialHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly refusal?: string;
  /** For `proof_failed` only: the fixed reason (`comment_edited`, `line_missing`, ...). Also in the body. */
  readonly reason?: string;
}

const NO_STORE = { "cache-control": "no-store" } as const;
const BEARER_INVALID = { ...NO_STORE, "www-authenticate": 'Bearer error="invalid_token"' } as const;

const ok = (body: Record<string, unknown>, status = 200): CredentialHttpResponse => ({ status, body, headers: NO_STORE });
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
  stopped: [403, "stopped"],
} as const;

const CONFIRM_REFUSALS = {
  revoked: "superseded",
  expired: "pending_expired",
  predecessor_revoked: "predecessor_revoked",
  not_found: "superseded",
  binding_required: "binding_required",
  stopped: "superseded",
} as const;

export type CredentialHttpInput =
  | { readonly op: "upgrade"; readonly result: MintedKey }
  | { readonly op: "rotate"; readonly result: MintedKey }
  | { readonly op: "confirm"; readonly credentialId: string; readonly result: ConfirmResult }
  | { readonly op: "revoke"; readonly credentialId: string; readonly revoked: boolean }
  /** upgrade was called with a session or a revocable key instead of a signed key. */
  | { readonly op: "signed_key_required" }
  /** the revoke body failed `revokeAgentCredentialOperation.input`. */
  | { readonly op: "invalid_input" }
  | { readonly op: "challenge"; readonly result: ChallengeOutcome }
  | { readonly op: "bind"; readonly result: BindOutcome }
  | { readonly op: "recover"; readonly result: RecoverOutcome }
  | { readonly op: "stop"; readonly result: StopOutcome }
  | { readonly op: "lift"; readonly result: LiftOutcome };

const RETRY_30 = { ...NO_STORE, "retry-after": "30" } as const;
const RETRY_60 = { ...NO_STORE, "retry-after": "60" } as const;
const RETRY_HOUR = { ...NO_STORE, "retry-after": "3600" } as const;

/** One mapping for every refusal of a proof, stop or lift. A code here is the node's log `errorCode`. */
const PROOF_REFUSALS: Record<string, [number, string, Readonly<Record<string, string>>?]> = {
  invalid_challenge: [401, "invalid_challenge"],
  proof_failed: [422, "proof_failed"],
  proof_unavailable: [503, "proof_unavailable", RETRY_30],
  rate_limited: [429, "rate_limited", RETRY_60],
  already_linked: [409, "already_linked"],
  binding_exists: [409, "binding_exists"],
  no_binding: [404, "no_binding"],
  recovery_limited: [429, "recovery_limited", RETRY_HOUR],
  not_agent: [403, "not_agent"],
  unknown_user: [403, "not_agent"],
  stopped: [403, "stopped"],
  authz_denied: [403, "authz_denied"],
  authz_unavailable: [503, "authz_unavailable", { ...NO_STORE, "retry-after": "5" }],
  principal_not_found: [404, "principal_not_found"],
  not_stopped: [409, "not_stopped"],
  self_lift: [403, "self_lift"],
};

function refuseProof(reason: string, failure?: string): CredentialHttpResponse {
  const [status, error, headers] = PROOF_REFUSALS[reason] ?? [409, reason];
  const res = refuse(status, error, headers ?? NO_STORE);
  return failure === undefined ? res : { ...res, body: { error, reason: failure }, reason: failure };
}

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
    case "challenge": {
      const r = input.result;
      if (!r.ok) return refuseProof(r.reason);
      return ok(
        proofChallengeOperation.output.parse({
          challengeId: r.challengeId,
          proofLine: r.proofLine,
          challengeSecret: r.challengeSecret,
          expiresAt: r.expiresAt,
          issues: [...r.issues],
        })
      );
    }
    case "bind": {
      const r = input.result;
      if (!r.ok) return refuseProof(r.reason, r.failure);
      return ok(
        bindGithubOperation.output.parse({ bound: true, githubId: r.githubId, userType: r.userType, result: r.result }),
        r.result === "created" ? 201 : 200
      );
    }
    case "recover": {
      const r = input.result;
      if (!r.ok) return refuseProof(r.reason, r.failure);
      return ok(
        recoverCredentialOperation.output.parse({
          userId: r.userId,
          credentialId: r.credentialId,
          apiKey: r.apiKey,
          status: "active",
          expiresAt: r.expiresAt,
          renewUntil: r.renewUntil,
        })
      );
    }
    case "stop":
      return input.result.ok ? ok(revokePrincipalOperation.output.parse({ revoked: input.result.revokedCount })) : refuseProof(input.result.reason);
    case "lift":
      return input.result.ok ? ok(liftStopOperation.output.parse({ lifted: true })) : refuseProof(input.result.reason);
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
