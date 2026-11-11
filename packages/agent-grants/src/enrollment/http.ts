// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment` http
 * Purpose: The fleet's ONE wire contract for the two public enrollment routes and the ONE mapping from a result to an HTTP status, body and headers.
 *   A node's Next route files call it and keep only parsing and the response object. The home node (the operator) is a client of exactly these shapes.
 * Scope: Framework-free. Returns `{ status, body, headers }`; builds no `Response`, reads no request, logs nothing.
 * Wire contract (story.0038, node-service-enrollment):
 *   POST /api/v1/public/agent/service-enrollments   body `{ token }`  (the signed enrollment JWT)
 *     200 `{ deviceCode, expires_in: 86400, interval: 5 }`
 *     401 `invalid_token` | `replayed_token`; 400 `invalid_scope`; 429 `too_many_enrollments` | `too_many_agents` | `node_full`; 503 `jwks_unavailable` | `authz_unavailable`
 *   POST /api/v1/public/agent/service-enrollments/token   body `{ deviceCode }`
 *     200 `{ sealedKey, credentialId, userId, status: "pending", pendingExpiresAt }`  (`sealedKey` is a compact JWE for the token's `cnf.jwk`; its plaintext is the key)
 *     400 `{ error }` with `error` one of the RFC 8628 codes `authorization_pending` | `slow_down` | `access_denied` | `expired_token`
 *     The holder then calls `POST /api/v1/agent/credentials/confirm` WITH the key to activate it.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: every 2xx body is parsed through its zod shape.
 *   - FAIL_CLOSED_NON_DISCLOSING: a bad, forged, wrong-audience or unknown-issuer token is one 401 `invalid_token`.
 *   - NEVER_CACHED: every response carries `cache-control: no-store`.
 *   - The sealed key and the device code are never logged by the node.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { z } from "zod";

import type { CredentialHttpResponse } from "../credentials/http";
import type { PollEnrollmentResult, RequestEnrollmentResult } from "./service";

export const requestServiceEnrollmentOperation = {
  id: "agent.service_enrollments.request",
  input: z.object({ token: z.string().min(1).max(4096) }),
  output: z.object({
    /** Shown once. Returned to the poller of POST .../token. */
    deviceCode: z.string().min(1),
    expires_in: z.number().int().positive(),
    interval: z.number().int().positive(),
  }),
} as const;

export const pollServiceEnrollmentOperation = {
  id: "agent.service_enrollments.token",
  input: z.object({ deviceCode: z.string().min(1).max(256) }),
  output: z.object({
    /** A compact JWE (ECDH-ES, A256GCM) for the token's `cnf.jwk`. The plaintext is the key string. */
    sealedKey: z.string().min(1),
    credentialId: z.string().min(1),
    userId: z.string().min(1),
    status: z.literal("pending"),
    pendingExpiresAt: z.string().min(1),
  }),
} as const;

const NO_STORE = { "cache-control": "no-store" } as const;
const ok = (body: Record<string, unknown>): CredentialHttpResponse => ({ status: 200, body, headers: NO_STORE });
const refuse = (
  status: number,
  error: string,
  headers: Readonly<Record<string, string>> = NO_STORE
): CredentialHttpResponse => ({ status, body: { error }, headers, refusal: error });

const REQUEST_REFUSALS = {
  invalid_token: [401, "invalid_token"],
  replayed_token: [401, "replayed_token"],
  invalid_scope: [400, "invalid_scope"],
  too_many_enrollments: [429, "too_many_enrollments"],
  too_many_agents: [429, "too_many_agents"],
  node_full: [429, "node_full"],
} as const;

export type EnrollmentHttpInput =
  | { readonly op: "request"; readonly result: RequestEnrollmentResult }
  | { readonly op: "poll"; readonly result: PollEnrollmentResult }
  | { readonly op: "invalid_input" };

/** The answer for the result of an enrollment route operation. */
export function enrollmentHttp(input: EnrollmentHttpInput): CredentialHttpResponse {
  switch (input.op) {
    case "invalid_input":
      return refuse(400, "invalid input");
    case "request": {
      const result = input.result;
      if (result.ok)
        return ok(requestServiceEnrollmentOperation.output.parse({ deviceCode: result.deviceCode, expires_in: result.expiresIn, interval: result.interval }));
      if (result.reason === "jwks_unavailable") return refuse(503, "jwks_unavailable", { ...NO_STORE, "retry-after": "5" });
      const [status, error] = REQUEST_REFUSALS[result.reason];
      return refuse(status, error, status === 429 ? { ...NO_STORE, "retry-after": "60" } : NO_STORE);
    }
    case "poll": {
      const result = input.result;
      if (!result.ok) return refuse(400, result.error);
      return ok(
        pollServiceEnrollmentOperation.output.parse({
          sealedKey: result.sealedKey,
          credentialId: result.credentialId,
          userId: result.userId,
          status: "pending",
          pendingExpiresAt: result.pendingExpiresAt,
        })
      );
    }
  }
}
