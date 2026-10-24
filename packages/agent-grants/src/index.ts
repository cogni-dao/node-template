// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants`
 * Purpose: Scoped, revocable agent access for a Cogni node — authorize(),
 *   the access-request → approval → grant lifecycle, and revocable credentials.
 * Scope: Re-exports only.
 * Invariants: scopes are plain strings declared by the node; identities are
 *   plain strings (users.id, billing_accounts.id).
 * Side-effects: none
 * Links: story.5115, knowledge node-capability-grants-standard
 * @public
 */

export {
  type AccessRequestDecision,
  type AccessRequestPreview,
  APPROVAL_TOKEN_TTL_MS,
  createAccessRequest,
  decideAccessRequest,
  MAX_GRANT_TTL_MS,
  previewAccessRequest,
} from "./access-requests";
export { type AccountAccess, authorize } from "./authorization";
export {
  hashAgentKey,
  isAgentCredentialLive,
  mintApprovalToken,
  recordAgentCredential,
  revokeAgentCredential,
} from "./credentials";
export {
  type AgentGrant,
  listOwnedGrants,
  replaceOwnedGrant,
  revokeOwnedGrant,
} from "./grants";
export { validateScopes } from "./scopes";
export {
  AgentGrantsError,
  type AgentGrantsDb,
  type AgentGrantsErrorCode,
} from "./types";
