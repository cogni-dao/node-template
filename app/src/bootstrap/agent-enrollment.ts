// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-enrollment`
 * Purpose: This node's wiring of `@cogni-dao/agent-grants/enrollment`: the service-role store, the per-IP limiter of the two public routes, the
 *   askable scopes and the billing account an enrolled service gets. (The trusted-home list and the token verifier are in the app layer:
 *   `@app/_lib/auth/service-enrollment-verifier`, because they read the operator attestation JWKS reader and bootstrap must not import app.)
 * Scope: Composition only. The four tables are deny-all for the app role (FORCE RLS, no policy), so the store gets the BYPASSRLS service
 *   connection. No decision lives here (the package decides).
 * Invariants:
 *   - ONE_BUCKET_PER_CLIENT: 30 requests per minute per client on the two public routes, keyed on Cloudflare's `cf-connecting-ip`, no burst.
 *   - A missing or broken service connection is an outage (503), never a 500 or a 401.
 * Side-effects: none at import (the store is built lazily); the limiter is in-memory
 * Links: packages/agent-grants/src/enrollment, https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @internal
 */

import { CredentialStoreUnavailableError, type CredentialSql } from "@cogni/agent-grants/credentials";
import { createPostgresEnrollmentStore, type EnrollmentStore } from "@cogni/agent-grants/enrollment";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { extractEdgeClientIp, TokenBucketRateLimiter } from "@/bootstrap/http/rateLimiter";

let store: EnrollmentStore | undefined;

/** A missing or broken service connection is an outage (503). */
export function getAgentEnrollmentStore(): EnrollmentStore {
  try {
    store ??= createPostgresEnrollmentStore(resolveServiceDb().$client as unknown as CredentialSql);
  } catch (cause) {
    throw new CredentialStoreUnavailableError(cause);
  }
  return store;
}

/** The scopes an outside agent can use on this node (a route twin exists). The package refuses an enrollment for any other scope. */
export function getAskableScopes(): readonly string[] {
  return getContainer().agentAuthority.askableScopes;
}

/**
 * 30 per minute per client on the two public routes, no burst. A polling home at the 5 second interval spends 12 a minute. At most 10 000
 * distinct clients are tracked (bounded LRU). Per-instance state, like the other public limiters.
 */
export const enrollmentLimiter = new TokenBucketRateLimiter({ maxTokens: 30, refillRate: 30 / 60, burstSize: 0, maxKeys: 10_000 });

/** The wrapper config for the two public routes: their own bucket, keyed on the Cloudflare client IP. */
export const enrollmentPublicRateLimit = { limiter: enrollmentLimiter, clientKey: extractEdgeClientIp } as const;

/** The enrolled service's billing account, through the SERVICE adapter (like registration). Idempotent: an existing account is returned. */
export async function ensureEnrollmentBillingAccount(userId: string, displayName: string): Promise<void> {
  await getContainer().serviceAccountService.getOrCreateBillingAccountForUser({ userId, displayName });
}
