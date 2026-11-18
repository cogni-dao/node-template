// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/dao-role`
 * Purpose: Apply a passed DAO `grant:role` / `revoke:role` signal to the node's grant rows, through the package's own `grantRole` / `revokeRole`.
 * Scope: Composition only. The package still validates the scope against the node's declarations, the kind, the principal and NO_SELF_APPROVAL.
 * Invariants:
 *   - DAO_IS_THE_APPROVER: the row's approver is the seeded DAO principal (users row `dao`, migration 0045), never cogni_system (the node's tenant, which
 *     never approves). `agent_roles.approved_by` is a users FK, so the signal's transaction hash is not on the row; the caller logs it (`agent_role.granted`).
 *   - ORDER_BY_CHAIN_TIME: a grant is refused when a revoke is at or after the signal's block time; a revoke is a no-op when the live row was granted after it.
 *   - AI_NEVER_SELF_APPROVES: the approver is never the AI principal (a node AI has its own seeded user); the package refuses `self_approval` anyway.
 * Side-effects: IO (store writes)
 * Links: packages/agent-grants/src/roles.ts, https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import {
  type AgentGrantsStore,
  type ApprovalCaller,
  grantRole,
  revokeRole,
  resolveInternalPrincipal,
  type ScopeKinds,
} from "@cogni/agent-grants";
import { DAO_PRINCIPAL_USER_ID } from "@cogni/node-shared";

/** The node app executing a passed vote. The package's `admin` proof is an opaque object; here its presence says "the DAO decided". */
const DAO_CALLER: ApprovalCaller = {
  userId: DAO_PRINCIPAL_USER_ID,
  admin: Object.freeze({ via: "dao_signal" }),
};

export async function applyDaoRole(
  store: AgentGrantsStore,
  input: {
    action: "grant" | "revoke";
    principalSlug: string;
    scope: string;
    declaredScopes: readonly string[];
    scopeKinds: ScopeKinds;
    /** Chain time of the signal's block, ms since epoch. */
    signalAtMs: number;
  }
): Promise<{ principalUserId: string | null; changed: boolean; stale: boolean }> {
  const { principalSlug, scope, declaredScopes, scopeKinds, signalAtMs } = input;
  // Row times are the database's processing time; the signal's time is its block time (see ORDER_BY_CHAIN_TIME).
  // ORDER_BY_CHAIN_TIME: a signal older than a later decision on the same (principal, scope) is a no-op, so a redelivered grant (restart, another replica)
  // cannot undo a later revoke, and a redelivered revoke cannot undo a later grant. The row times are the database's, the signal's is the block's.
  const userId = await resolveInternalPrincipal(store, principalSlug);
  if (userId) {
    const t = await store.nodeRoleTimes(userId, scope);
    const stale =
      input.action === "grant"
        ? t.lastRevokedAt !== null && t.lastRevokedAt >= signalAtMs
        : t.liveGrantedAt !== null && t.liveGrantedAt > signalAtMs;
    if (stale) return { principalUserId: userId, changed: false, stale: true };
  }
  if (input.action === "grant") {
    const r = await grantRole(store, { principalSlug, scope, me: DAO_CALLER, declaredScopes, scopeKinds });
    return { principalUserId: r.principalUserId, changed: r.created, stale: false };
  }
  const r = await revokeRole(store, { principalSlug, scope, me: DAO_CALLER, scopeKinds });
  return { principalUserId: r.principalUserId, changed: r.revoked, stale: false };
}
