// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/authorization`
 * Purpose: The ONE account authorization decision — may this principal act on
 *   this billing account under this scope? Ported from Poly (950e155,
 *   app/src/features/agent-grants/authorization.ts) minus its scope type and
 *   the `performance:read` alias.
 * Scope: Read-only. The caller provides an app-role transaction whose tenant
 *   context is already set to the same principal.
 * Invariants:
 *   - ONE_AUTHORIZE_FN: no other module decides delegated account access.
 *   - MIRRORS_SQL: owner OR (unrevoked, unexpired grant to the principal whose
 *     scopes contain requiredScope) — the same predicate as the SQL function
 *     `agent_has_scope()` that RLS policies call (migration 0034).
 *   - RLS_BACKSTOP: an allow is necessary, never sufficient; reads stay
 *     RLS-clamped.
 *   - FAIL_CLOSED: every denial is null; transports render one non-disclosing
 *     404.
 *   - NEVER_CACHED: recomputed per request.
 * Side-effects: IO (bounded Postgres reads)
 * @public
 */

import { agentCapabilityGrants } from "@cogni/db-schema/agent-grants";
import { billingAccounts } from "@cogni/db-schema/refs";
import { and, arrayContains, eq, gt, isNull, sql } from "drizzle-orm";

import type { AgentGrantsDb } from "./types";

export type AccountAccess = {
  accessKind: "owner" | "delegated";
  grantId: string | null;
};

export async function authorize(
  tx: AgentGrantsDb,
  input: { principalId: string; accountId: string; requiredScope: string }
): Promise<AccountAccess | null> {
  const [owned] = await tx
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.id, input.accountId),
        eq(billingAccounts.ownerUserId, input.principalId)
      )
    )
    .limit(1);
  if (owned) return { accessKind: "owner", grantId: null };

  const [grant] = await tx
    .select({ id: agentCapabilityGrants.id })
    .from(agentCapabilityGrants)
    .where(
      and(
        eq(agentCapabilityGrants.billingAccountId, input.accountId),
        eq(agentCapabilityGrants.granteePrincipalId, input.principalId),
        isNull(agentCapabilityGrants.revokedAt),
        gt(agentCapabilityGrants.expiresAt, sql`now()`),
        arrayContains(agentCapabilityGrants.scopes, [input.requiredScope])
      )
    )
    .limit(1);
  return grant ? { accessKind: "delegated", grantId: grant.id } : null;
}
