// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/same-door`
 * Purpose: SAME_DOOR. The one declaration of which agent-reachable route twins which guarded tool, or which read route needs a grant, and the one
 *   check a route calls. An outside agent that calls the route passes the same `authorize()` lock as the node's own AI.
 * Scope: A static map (tool id -> route ids + scope), an allowlist of tools that have no node route, and `authorizeCaller`.
 *   The parity test (packages/langgraph-graphs/tests/same-door-parity.test.ts) fails when a non-read_only tool is in neither.
 * Invariants:
 *   - SAME_DOOR: a bearer caller is its own principal. It needs a live role row for the scope: the same principal lock the
 *     tool guard runs. A denied bearer gets 403 `policy_denied`; a store outage gets 503 `authz_unavailable`.
 *   - Humans are subjects, not principals. A signed-in human passes `member`; `admin` needs the node admin check. A human
 *     needs no role row.
 *   - TOOL_HAS_ROUTE_TWIN: every non-read_only tool is in `SAME_DOOR_ROUTES` or in `NO_ROUTE_TWIN` with a reason.
 *   - NEVER_CACHED: every call reads the store.
 * Side-effects: IO (store reads, through `authorize`)
 * @public
 */

import { authorize } from "./authorize";
import type {
  AdminCheck,
  AgentGrantsStore,
  AuthzDecision,
  ToolRequires,
} from "./types";

/** One tool and the route ids (the `routeId` in each route's wrapper options) that twin it. */
export interface SameDoorRoute {
  readonly scope: string;
  readonly routes: readonly string[];
}

/** tool id -> the agent-reachable write routes that carry the same scope. */
export const SAME_DOOR_ROUTES: Readonly<Record<string, SameDoorRoute>> = {
  core__work_item_update: {
    scope: "work_item:transition",
    routes: ["work.items.patch"],
  },
  core__schedule_manage: {
    scope: "schedule:manage",
    routes: ["schedules.create", "schedules.update", "schedules.delete"],
  },
  core__edo_hypothesize: { scope: "edo:write", routes: ["edo.hypothesize"] },
  core__edo_decide: { scope: "edo:write", routes: ["edo.decide"] },
  core__edo_record_outcome: { scope: "edo:write", routes: ["edo.record_outcome"] },
  core__metric_compute: { scope: "metric:compute", routes: ["metrics.metricCompute"] },
};

/**
 * Routes an outside agent may call that no tool twins (writes, and the knowledge reads). They declare their own scope here, once, with the same
 * `requires` shape a tool contract uses. A signed-in human passes `member`; a bearer agent needs a live role row.
 */
export const ROUTE_ONLY_CAPABILITIES: Readonly<
  Record<string, { readonly requires: ToolRequires; readonly routes: readonly string[] }>
> = {
  "knowledge.read": {
    requires: {
      scope: "knowledge:read",
      kind: "node",
      subject: "member",
      label: "Read the knowledge base",
      description: "Read this node's published notes. A signed-in person always can; an agent needs an admin's yes.",
    },
    routes: [
      "knowledge.list",
      "knowledge.get",
      "knowledge.history",
      "knowledge.browse",
      "knowledge.index",
      "knowledge.graph",
      "knowledge.domains.list",
      "knowledge.domains.get",
    ],
  },
  "knowledge.contribute": {
    requires: {
      scope: "knowledge:contribute",
      kind: "node",
      subject: "member",
      label: "Propose changes to the knowledge base",
      description: "Suggest new or changed notes. An admin still decides what is kept.",
    },
    routes: [
      "knowledge.contributions.create",
      "knowledge.contributions.commits.append",
    ],
  },
};

/** Tools that have no node route, with the reason. A new tool must be added here or to `SAME_DOOR_ROUTES`. */
export const NO_ROUTE_TWIN: Readonly<Record<string, string>> = {
  // Deprecated (task.0065): core__work_item_update twins work.items.patch; this tool keeps its scope but carries no route.
  core__work_item_transition: "deprecated; core__work_item_update is the twin of work.items.patch",
  // These call the operator's API with the node's identity; the operator's own deploy roles (operator OpenFGA) gate them.
  // The tool writes straight to main. Its true twin (a direct-to-main knowledge write route) deliberately does not
  // exist: the node route an outside agent uses is the contribution proposal (`knowledge.contribute`). Whether the tool
  // should write contributions instead of main is a design question (C2, task.5465).
  core__knowledge_write: "no direct-to-main write route exists on purpose; outside agents use knowledge.contribute",
  core__vcs_create_branch: "calls the operator VCS API, not a node route",
  core__vcs_merge_pr: "calls the operator VCS API, not a node route",
  core__vcs_flight_candidate: "calls the operator VCS API, not a node route",
};

/**
 * Write routes on this node that sit next to a gated capability but are NOT the same capability, so they carry no
 * door yet. Each names the design item that decides it. The route enumeration test (app/tests/unit/app/same-door-routes.test.ts)
 * fails when a write handler under the work, schedules, edo, knowledge or metrics routes is in neither this list nor
 * `SAME_DOOR_ROUTES` / `ROUTE_ONLY_CAPABILITIES`.
 */
export const DEFERRED_WRITE_ROUTES: Readonly<Record<string, string>> = {
  "work.items.create": "creating an item is not work_item:transition; open question for task.5466 (ask-for-access) / task.5465",
  "work.items.delete": "retired (HTTP 410); no capability to gate",
  "work.items.claim": "coordination, not work_item:transition; task.5465",
  "work.items.release": "coordination, not work_item:transition; task.5465",
  "work.items.heartbeat": "coordination, not work_item:transition; task.5465",
  "knowledge.contributions.close": "contribution lifecycle; C2 design question (task.5465)",
  "knowledge.contributions.merge": "already admin-session gated in the service; C2 design question (task.5465)",
  "knowledge.domains.create": "domain registry writes; C2 design question (task.5465)",
  "knowledge.domains.update": "domain registry writes; C2 design question (task.5465)",
  "knowledge.domains.delete": "domain registry writes; C2 design question (task.5465)",
};

/**
 * Write routes that carry no door by design.
 * The ask door must be callable by ANY signed-in agent with no prior grant, or nobody could ever ask for one.
 * NO_SELF_APPROVAL protects activation: the ask writes a pending row with no approver; only an admin session turns it on.
 */
export const OPEN_BY_DESIGN_ROUTES: Readonly<Record<string, string>> = {
  "agent.access.requests.create": "the ask door is open by design; NO_SELF_APPROVAL protects activation (only an admin session approves)",
  "agent.register": "the anonymous onboarding door that mints an agent identity and key (bug.0297, an invitation token is tracked there); an identity alone opens no route: only an admin's yes does",
};

export interface CallerInput {
  readonly userId: string;
  /** How the request authenticated. `bearer` is an AI on the AI plane; `session` is a human. */
  readonly via: "bearer" | "session";
  readonly requires: ToolRequires;
}

/** The route door. Same `authorize()` for a bearer (its own principal); subject rules only for a human. */
export async function authorizeCaller(
  store: AgentGrantsStore,
  adminCheck: AdminCheck,
  input: CallerInput
): Promise<AuthzDecision> {
  const { userId, via, requires } = input;
  if (via === "bearer") {
    // The bearer IS the principal. `own` data belongs to it, so it is also the subject there. `admin`-subject scopes
    // pass on the role row alone: a DAO admin wrote that row, and an AI identity has no admin check yet (item I2).
    return authorize(store, adminCheck, {
      principalId: userId,
      subjectUserId: requires.kind === "own" ? userId : undefined,
      requires:
        requires.subject === "admin" ? { ...requires, subject: "member" } : requires,
    });
  }
  if (requires.kind === "account")
    return { decision: "deny", code: "policy_denied", reason: "account_scope_unsupported" };
  if (requires.subject === "member") return { decision: "allow", basis: "signed_in" };
  if (requires.subject !== "admin")
    return { decision: "deny", code: "policy_denied", reason: "unknown_contract_value" };
  let admin: Awaited<ReturnType<AdminCheck>>;
  try {
    admin = await adminCheck(userId);
  } catch {
    return { decision: "deny", code: "authz_unavailable", reason: "admin_check_failed" };
  }
  if (admin === "unavailable")
    return { decision: "deny", code: "authz_unavailable", reason: "no_admin_authority" };
  return admin === "allow"
    ? { decision: "allow", basis: "node_admin" }
    : { decision: "deny", code: "policy_denied", reason: "subject_not_admin" };
}
