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
 *   - ONE_PREDICATE: owner OR the SQL function `agent_grant_has_scope()` —
 *     the same function the RLS delegated-read policies call (migration
 *     0034); together they equal SQL `agent_has_scope()`.
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
import { and, eq, isNull, sql } from "drizzle-orm";

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

  // The delegated decision IS the SQL function the RLS policies call, so the
  // app check and RLS cannot disagree. The row only supplies grantId for
  // audit: SINGLE_CURRENT_GRANT means at most one unrevoked grant per
  // (account, grantee), and a true decision implies it exists.
  const [grant] = await tx
    .select({
      id: agentCapabilityGrants.id,
      allowed: sql<boolean>`agent_grant_has_scope(${input.accountId}, ${input.requiredScope})`,
    })
    .from(agentCapabilityGrants)
    .where(
      and(
        eq(agentCapabilityGrants.billingAccountId, input.accountId),
        eq(agentCapabilityGrants.granteePrincipalId, input.principalId),
        isNull(agentCapabilityGrants.revokedAt)
      )
    )
    .limit(1);
  return grant?.allowed === true
    ? { accessKind: "delegated", grantId: grant.id }
    : null;
}
