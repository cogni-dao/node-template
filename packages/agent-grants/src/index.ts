// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants`
 * Purpose: Public surface of runtime agent tool authority.
 * Scope: Re-exports only.
 * Side-effects: none
 * @public
 */

export { type AuthorizeInput, authorize } from "./authorize";
export {
  type GuardableRuntime,
  type GuardDeps,
  type GuardScope,
  guardTools,
  ToolAuthorityError,
} from "./guard";
export {
  buildNodeAiView,
  NODE_AI_COPY,
  type NodeAiCopy,
} from "./node-ai";
export { createPostgresAgentGrantsStore, type SqlTag } from "./postgres";
export {
  AgentRolesError,
  grantRole,
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
  JobRisk,
  NodeAiAccessView,
  NodeAiJobView,
  NodeAiView,
  RunIdentity,
  ScopeKind,
  SubjectRequirement,
  ToolRequires,
  WithStore,
} from "./types";
