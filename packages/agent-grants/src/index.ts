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
  type RouteOnlyCapability,
  SAME_DOOR_ROUTES,
  type SameDoorRoute,
} from "./same-door";
export { agentNameKey, hasHiddenCharacters } from "./names";
export { buildNodeAiView } from "./node-ai";
export { createPostgresAgentGrantsStore, type SqlTag } from "./postgres";
export {
  AgentRolesError,
  denyRequest,
  grantRole,
  listOwnAccess,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_TOTAL,
  type PrincipalRef,
  requestAccess,
  type RolesErrorCode,
  resolveInternalPrincipal,
  revokeRole,
} from "./roles";
export type {
  AdminCheck,
  AdminDecision,
  AgentGrantsStore,
  AuthzDecision,
  AuthzEvent,
  DenialCode,
  NodeAiAccessView,
  AccessSection,
  NodeAiPermissionView,
  RoleRow,
  RoleState,
  RunIdentity,
  ScopeKind,
  SubjectRequirement,
  ToolRequires,
  WithStore,
} from "./types";
