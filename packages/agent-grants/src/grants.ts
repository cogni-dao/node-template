// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/grants`
 * Purpose: Owner-scoped grant lifecycle — list, replace (used by approval),
 *   and soft revoke. Ported from Poly (950e155, agent-grant-service.ts).
 * Scope: App-role transaction-local reads/writes; HTTP and logging live above.
 * Invariants:
 *   - OWNER_ONLY: explicit owner predicates complement RLS.
 *   - ATOMIC_REPLACE: replace revokes the prior current grant and inserts the
 *     new one in the caller's transaction.
 *   - SOFT_REVOKE: rows are never deleted.
 * Side-effects: IO (Postgres)
 * @public
 */

import {
  type AgentCapabilityGrantRow,
  agentAccessRequests,
  agentCapabilityGrants,
} from "@cogni/db-schema/agent-grants";
import { billingAccounts } from "@cogni/db-schema/refs";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { AgentGrantsDb } from "./types";

export type AgentGrant = AgentCapabilityGrantRow;

export async function listOwnedGrants(
  tx: AgentGrantsDb,
  ownerId: string
): Promise<AgentGrant[]> {
  const rows = await tx
    .select({ grant: agentCapabilityGrants })
    .from(agentCapabilityGrants)
    .innerJoin(
      billingAccounts,
      eq(agentCapabilityGrants.billingAccountId, billingAccounts.id)
    )
    .where(eq(billingAccounts.ownerUserId, ownerId))
    .orderBy(desc(agentCapabilityGrants.createdAt));
  return rows.map(({ grant }) => grant);
}

/** Revoke any current grant for (account, grantee) and insert a new one. */
export async function replaceOwnedGrant(
  tx: AgentGrantsDb,
  input: {
    ownerId: string;
    accountId: string;
    granteeId: string;
    scopes: string[];
    expiresAt: Date;
  }
): Promise<AgentGrant | null> {
  const [owned] = await tx
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.id, input.accountId),
        eq(billingAccounts.ownerUserId, input.ownerId)
      )
    )
    .limit(1);
  if (!owned) return null;

  const replaced = await tx
    .update(agentCapabilityGrants)
    .set({
      revokedAt: sql`now()`,
      revokedByUserId: input.ownerId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentCapabilityGrants.billingAccountId, input.accountId),
        eq(agentCapabilityGrants.granteePrincipalId, input.granteeId),
        isNull(agentCapabilityGrants.revokedAt)
      )
    )
    .returning({ id: agentCapabilityGrants.id });
  await markRequestsRevoked(
    tx,
    replaced.map(({ id }) => id)
  );

  const [created] = await tx
    .insert(agentCapabilityGrants)
    .values({
      billingAccountId: input.accountId,
      granteePrincipalId: input.granteeId,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      createdByUserId: input.ownerId,
    })
    .returning();
  return created ?? null;
}

/** Soft-revoke a grant on an account the owner owns. Null = not found/not owned. */
export async function revokeOwnedGrant(
  tx: AgentGrantsDb,
  input: { ownerId: string; grantId: string }
): Promise<AgentGrant | null> {
  const [revoked] = await tx
    .update(agentCapabilityGrants)
    .set({
      revokedAt: sql`now()`,
      revokedByUserId: input.ownerId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentCapabilityGrants.id, input.grantId),
        isNull(agentCapabilityGrants.revokedAt),
        sql`${agentCapabilityGrants.billingAccountId} IN (
          SELECT id FROM billing_accounts WHERE owner_user_id = ${input.ownerId}
        )`
      )
    )
    .returning();
  if (revoked) await markRequestsRevoked(tx, [revoked.id]);
  return revoked ?? null;
}

async function markRequestsRevoked(
  tx: AgentGrantsDb,
  grantIds: string[]
): Promise<void> {
  if (grantIds.length === 0) return;
  await tx
    .update(agentAccessRequests)
    .set({ status: "revoked", updatedAt: sql`now()` })
    .where(
      and(
        inArray(agentAccessRequests.approvedGrantId, grantIds),
        eq(agentAccessRequests.status, "approved")
      )
    );
}
