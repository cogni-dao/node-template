// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/dao-role`
 * Purpose: Apply a passed DAO `grant:role` / `revoke:role` signal to the node's grant rows, through the package's own `grantRole` / `revokeRole`.
 * Scope: Composition only. The package still validates the scope against the node's declarations, the kind, the principal and NO_SELF_APPROVAL.
 * Invariants:
 *   - DAO_IS_THE_APPROVER: the row's approver is the cogni_system principal, the identity the node's app acts as when it executes the DAO's vote.
 *     `agent_roles.approved_by` is a users FK, so the signal's transaction hash is not on the row; the caller logs it (`agent_role.granted`).
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
  type ScopeKinds,
} from "@cogni/agent-grants";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";

/** The node app executing a passed vote. The package's `admin` proof is an opaque object; here its presence says "the DAO decided". */
const DAO_CALLER: ApprovalCaller = {
  userId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
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
  }
): Promise<{ principalUserId: string; changed: boolean }> {
  const { principalSlug, scope, declaredScopes, scopeKinds } = input;
  if (input.action === "grant") {
    const r = await grantRole(store, { principalSlug, scope, me: DAO_CALLER, declaredScopes, scopeKinds });
    return { principalUserId: r.principalUserId, changed: r.created };
  }
  const r = await revokeRole(store, { principalSlug, scope, me: DAO_CALLER, scopeKinds });
  return { principalUserId: r.principalUserId, changed: r.revoked };
}
