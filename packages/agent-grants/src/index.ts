// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants`
 * Purpose: Public surface of runtime agent tool authority.
 * Scope: Re-exports only.
 * Side-effects: none
 * @public
 */

export { type AccountAccess, authorizeAccount } from "./account";
export {
  type AuthorizeInput,
  authorize,
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
export { buildNodeAiView } from "./node-ai";
export { buildYourAisView } from "./your-ais";
export { createPostgresAgentGrantsStore, type SqlTag } from "./postgres";
export {
  AgentRolesError,
  denyRequest,
  grantPersonal,
  grantRole,
  listOwnAccess,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_TOTAL,
  PERSONAL_GRANT_TTL_DAYS,
  type PrincipalRef,
  requestAccess,
  type RolesErrorCode,
  resolveInternalPrincipal,
  revokePersonal,
  revokeRole,
} from "./roles";
export type {
  AdminCheck,
  AdminDecision,
  AgentGrantsStore,
  AuthzDecision,
  AuthzEvent,
  DenialCode,
  GrantResource,
  NodeAiAccessView,
  AccessSection,
  NodeAiPermissionView,
  OwnRoleRow,
  PersonalRow,
  PersonalScopeKind,
  RoleRow,
  RoleState,
  RunIdentity,
  ScopeKind,
  SubjectRequirement,
  ToolRequires,
  WithStore,
  YourAiAccessView,
  YourAiPermissionView,
} from "./types";
