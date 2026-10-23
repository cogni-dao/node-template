// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/access-requests`
 * Purpose: Agent self-requested scopes → one-time approval link → owner
 *   decision that writes the grant in the same transaction. Ported from Poly
 *   (950e155, agent-access-request-service.ts) with node-declared scopes and
 *   an approver-chosen account.
 * Scope: App-role transaction-local reads/writes. HTTP and logs live above.
 * Invariants:
 *   - TOKEN_HASH_ONLY: the raw approval token is returned once to the agent
 *     and never persisted; preview/decide select by sha256(token) through a
 *     transaction-local setting the RLS policies read.
 *   - ONE_TIME: decide only matches a pending, unexpired request; the status
 *     flip is the consumption.
 *   - APPROVAL_IS_ATOMIC: grant insert and request approval share the caller's
 *     transaction; a lost race throws so the grant rolls back.
 *   - DECLARED_SCOPES: requested scopes are validated on create AND re-checked
 *     on approval against the node's declared list.
 * Side-effects: IO (Postgres), randomness (approval token)
 * @public
 */

import { agentAccessRequests } from "@cogni/db-schema/agent-grants";
import { billingAccounts } from "@cogni/db-schema/refs";
import { and, eq, gt, lte, sql } from "drizzle-orm";

import { hashAgentKey, mintApprovalToken } from "./credentials";
import { replaceOwnedGrant } from "./grants";
import { validateScopes } from "./scopes";
import { AgentGrantsError, type AgentGrantsDb } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_TOKEN_TTL_MS = DAY_MS;
export const MAX_GRANT_TTL_MS = 30 * DAY_MS;

export type AccessRequestPreview = {
  id: string;
  requesterDisplayName: string | null;
  requestedScopes: string[];
  grantExpiresAt: Date;
};

export type AccessRequestDecision = {
  id: string;
  status: "approved" | "denied";
  requesterPrincipalId: string;
  billingAccountId: string;
  grantId: string | null;
};

async function setTokenContext(tx: AgentGrantsDb, tokenHash: string) {
  await tx.execute(
    sql`SELECT set_config('app.agent_access_request_token_hash', ${tokenHash}, true)`
  );
}

export async function createAccessRequest(
  tx: AgentGrantsDb,
  input: {
    principalId: string;
    displayName: string | null;
    scopes: readonly string[];
    declaredScopes: readonly string[];
    grantTtlMs?: number | undefined;
    now?: Date | undefined;
  }
): Promise<{ id: string; token: string; tokenExpiresAt: Date }> {
  const now = input.now ?? new Date();
  const scopes = validateScopes(input.scopes, input.declaredScopes);
  const ttl = input.grantTtlMs ?? MAX_GRANT_TTL_MS;
  if (!(ttl > 0 && ttl <= MAX_GRANT_TTL_MS)) {
    throw new AgentGrantsError("invalid_expiry", "grant TTL out of range");
  }

  // Lazily expire this requester's stale pending row so it can ask again.
  await tx
    .update(agentAccessRequests)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(agentAccessRequests.requesterPrincipalId, input.principalId),
        eq(agentAccessRequests.status, "pending"),
        lte(agentAccessRequests.approvalTokenExpiresAt, now)
      )
    );

  const [pending] = await tx
    .select({ id: agentAccessRequests.id })
    .from(agentAccessRequests)
    .where(
      and(
        eq(agentAccessRequests.requesterPrincipalId, input.principalId),
        eq(agentAccessRequests.status, "pending")
      )
    )
    .limit(1);
  if (pending) {
    throw new AgentGrantsError(
      "pending_exists",
      "a pending access request already exists"
    );
  }

  const { token, tokenHash } = mintApprovalToken();
  const tokenExpiresAt = new Date(now.getTime() + APPROVAL_TOKEN_TTL_MS);
  const [created] = await tx
    .insert(agentAccessRequests)
    .values({
      requesterPrincipalId: input.principalId,
      requesterDisplayName: input.displayName,
      requestedScopes: scopes,
      grantExpiresAt: new Date(now.getTime() + ttl),
      approvalTokenHash: tokenHash,
      approvalTokenExpiresAt: tokenExpiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: agentAccessRequests.id });
  if (!created) throw new Error("access request insert returned no row");
  return { id: created.id, token, tokenExpiresAt };
}

export async function previewAccessRequest(
  tx: AgentGrantsDb,
  input: { token: string; now?: Date | undefined }
): Promise<AccessRequestPreview | null> {
  const now = input.now ?? new Date();
  const tokenHash = hashAgentKey(input.token);
  await setTokenContext(tx, tokenHash);
  const [row] = await tx
    .select()
    .from(agentAccessRequests)
    .where(
      and(
        eq(agentAccessRequests.approvalTokenHash, tokenHash),
        eq(agentAccessRequests.status, "pending"),
        gt(agentAccessRequests.approvalTokenExpiresAt, now)
      )
    )
    .limit(1);
  return row
    ? {
        id: row.id,
        requesterDisplayName: row.requesterDisplayName,
        requestedScopes: row.requestedScopes,
        grantExpiresAt: row.grantExpiresAt,
      }
    : null;
}

/**
 * Owner decision. `accountId` is the approver's chosen account; when omitted
 * the approver's own account is used. Null = no pending request for this
 * token, or the approver does not own the account.
 */
export async function decideAccessRequest(
  tx: AgentGrantsDb,
  input: {
    token: string;
    ownerId: string;
    accountId?: string | undefined;
    decision: "approve" | "deny";
    declaredScopes: readonly string[];
    now?: Date | undefined;
  }
): Promise<AccessRequestDecision | null> {
  const now = input.now ?? new Date();
  const tokenHash = hashAgentKey(input.token);
  await setTokenContext(tx, tokenHash);
  const [request] = await tx
    .select()
    .from(agentAccessRequests)
    .where(
      and(
        eq(agentAccessRequests.approvalTokenHash, tokenHash),
        eq(agentAccessRequests.status, "pending"),
        gt(agentAccessRequests.approvalTokenExpiresAt, now),
        gt(agentAccessRequests.grantExpiresAt, now)
      )
    )
    .limit(1)
    .for("update");
  if (!request) return null;

  const [account] = await tx
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.ownerUserId, input.ownerId),
        input.accountId ? eq(billingAccounts.id, input.accountId) : undefined
      )
    )
    .limit(1);
  if (!account) return null;

  let grantId: string | null = null;
  if (input.decision === "approve") {
    const grant = await replaceOwnedGrant(tx, {
      ownerId: input.ownerId,
      accountId: account.id,
      granteeId: request.requesterPrincipalId,
      scopes: validateScopes(request.requestedScopes, input.declaredScopes),
      expiresAt: request.grantExpiresAt,
    });
    if (!grant) throw new AgentGrantsError("conflict", "grant not created");
    grantId = grant.id;
  }

  const status = input.decision === "approve" ? "approved" : "denied";
  const [decided] = await tx
    .update(agentAccessRequests)
    .set({
      status,
      billingAccountId: account.id,
      approvedGrantId: grantId,
      decisionByUserId: input.ownerId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentAccessRequests.id, request.id),
        eq(agentAccessRequests.status, "pending")
      )
    )
    .returning({ id: agentAccessRequests.id });
  if (!decided) {
    // Throw so the caller's transaction rolls back the grant insert.
    throw new AgentGrantsError("conflict", "request was concurrently decided");
  }
  return {
    id: request.id,
    status,
    requesterPrincipalId: request.requesterPrincipalId,
    billingAccountId: account.id,
    grantId,
  };
}
