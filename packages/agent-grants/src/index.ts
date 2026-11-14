// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants`
 * Purpose: Public surface of runtime agent tool authority.
 * Scope: Re-exports only.
 * Side-effects: none
 * @public
 */

export {
  type CatalogEntryLike,
  listMine,
  MAX_ACCOUNT_ROWS,
  type MineListInput,
  type MineOffInput,
  type MineOnInput,
  type MineOnResult,
  scopesByPrincipalOf,
  turnMineOff,
  turnMineOn,
} from "./account-access";
export {
  ACCOUNT_GRANT_DAYS,
  type AccountGrantDays,
  APPROVAL_FRAGMENT_KEY,
  APPROVAL_PAGE,
  type ApprovalCaller,
  type ApprovalRow,
  approvalPath,
  canApprove,
  DEFAULT_ACCOUNT_GRANT_DAYS,
  hashLinkToken,
  isAccountGrantDays,
  isLinkTokenShape,
  LINK_TTL_MS,
  newLinkToken,
  resourceOfKind,
} from "./approval";
export {
  type AuthorizeAccountInput,
  type AuthorizeInput,
  authorize,
  authorizeAccount,
  authorizePrincipalLock,
  principalLockPrecheck,
} from "./authorize";
export {
  type GuardableRuntime,
  type GuardDeps,
  type GuardScope,
  guardTools,
  offeredToolIds,
  type TerminalDenial,
  ToolAuthorityError,
} from "./guard";
export {
  authorizeCaller,
  type CallerInput,
  DEFERRED_WRITE_ROUTES,
  NO_ROUTE_TWIN,
  OPEN_BY_DESIGN_ROUTES,
  ROUTE_ONLY_CAPABILITIES,
  SAME_DOOR_ROUTES,
  type SameDoorRoute,
} from "./same-door";
export { agentNameKey, hasHiddenCharacters } from "./names";
export { buildAccountAiView, buildAskView, buildNodeAiView } from "./node-ai";
export { createPostgresAgentGrantsStore, type SqlTag } from "./postgres";
export {
  AgentRolesError,
  type AskOutcome,
  approveAccountAsk,
  denyAccountAsk,
  denyRequest,
  grantInternalOnAccount,
  grantRole,
  listOwnAccess,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_TOTAL,
  type PrincipalRef,
  previewAsk,
  requestAccess,
  type RolesErrorCode,
  resolveInternalPrincipal,
  revokeAccountRow,
  revokeRole,
  type ScopeKinds,
} from "./roles";
export type {
  AccountAccess,
  AdminCheck,
  AdminDecision,
  AgentGrantsStore,
  AskLink,
  AskResult,
  AuthzDecision,
  AuthzEvent,
  DenialCode,
  GrantResource,
  NodeAiAccessView,
  AccessSection,
  NodeAiPermissionView,
  PendingAskView,
  RoleRow,
  RoleState,
  RunIdentity,
  ScopeKind,
  SubjectRequirement,
  ToolRequires,
  WithStore,
} from "./types";
