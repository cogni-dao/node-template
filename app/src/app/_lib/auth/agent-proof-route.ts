// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/auth/agent-proof-route`
 * Purpose: The shared shell of the proof routes (bind challenge, bind, recover, stop twin, lift twin): parse the body, map a package result to its
 *   HTTP answer, and write exactly ONE terminal event per operation.
 * Scope: Plumbing only. Every decision, limit and status code lives in `@cogni-dao/agent-grants/credentials`.
 * Invariants:
 *   - ONE_TERMINAL_EVENT: a success event, or `agent.proof.refused` (challenge, bind, recover), or `agent.credential.refused` (stop, lift).
 *   - NO_SECRETS_IN_LOGS: fields are ids, a fixed error code and a fixed reason. Never a key, a challenge secret, a nonce, a hash, a token or a login.
 *   - NEVER_CACHED: every answer is the package's `no-store` response.
 * Side-effects: logs
 * @internal
 */

import { type CredentialHttpInput, type CredentialHttpResponse, credentialHttp } from "@cogni/agent-grants/credentials";
import type { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";

import { credentialResponse } from "@/app/_lib/auth/agent-credential-route";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";

export const invalidInput = (): NextResponse => credentialResponse(credentialHttp({ op: "invalid_input" }));

/** The parsed JSON body, or null when it is missing, not JSON or fails the schema (the caller answers 400). */
export async function parseProofBody<T extends z.ZodTypeAny>(request: NextRequest, schema: T): Promise<z.infer<T> | null> {
  const body = await request.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Log one terminal refusal for an answer that carries a `refusal` code. Proof routes log `agent.proof.refused`; stop and lift log `agent.credential.refused`. */
function logRefusal(ctx: RequestContext, routeId: string, http: CredentialHttpResponse, kind: "proof" | "credential", ids: Record<string, string>): void {
  const event = kind === "proof" ? EVENT_NAMES.AGENT_PROOF_REFUSED : EVENT_NAMES.AGENT_CREDENTIAL_REFUSED;
  ctx.log.warn({ event, routeId, errorCode: http.refusal, ...(http.reason ? { reason: http.reason } : {}), ...ids }, event);
}

/**
 * Answer a proof-route result. A refusal logs its terminal refusal; a success calls `onSuccess` (which logs the success event). Returns the response.
 * `ids` are plain ids (user ids, challenge ids) and are added to a refusal line.
 */
export function answerProof(
  ctx: RequestContext,
  routeId: string,
  input: CredentialHttpInput,
  options: { kind: "proof" | "credential"; ids?: Record<string, string>; onSuccess?: () => void }
): NextResponse {
  const http = credentialHttp(input);
  if (http.refusal) logRefusal(ctx, routeId, http, options.kind, options.ids ?? {});
  else options.onSuccess?.();
  return credentialResponse(http);
}
