// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/same-door`
 * Purpose: SAME_DOOR. The one declaration of which agent-reachable route twins which guarded tool (a write tool, or a read tool that declares an
 *   `account` scope), or which read route needs a grant, and the one check a route calls. An outside agent that calls the route passes the same `authorize()` lock as the node's own AI.
 * Scope: A static map (tool id -> route ids + scope), an allowlist of tools that have no node route, and `authorizeCaller`.
 *   The parity suite (`@cogni-dao/agent-grants/same-door-parity`) fails when a non-read_only tool is in neither; a node runs it over its composed set.
 * Invariants:
 *   - SAME_DOOR: a bearer caller is its own principal. It needs a live role row for the scope: the same principal lock the
 *     tool guard runs. A denied bearer gets 403 `policy_denied`; a store outage gets 503 `authz_unavailable`.
 *   - Humans are subjects, not principals. A signed-in human passes `member`; `admin` needs the node admin check. A human
 *     needs no role row.
 *   - TOOL_HAS_ROUTE_TWIN: every non-read_only tool is in `SAME_DOOR_ROUTES` or in `NO_ROUTE_TWIN` with a reason.
 *   - NODE_ADDS_ONLY: a node adds route twins and route-only capabilities through `AgentRoutes` (`composeAgentRoutes`); a collision with the baseline throws.
 *   - NEVER_CACHED: every call reads the store.
 * Side-effects: IO (store reads, through `authorize`)
 * @public
 */

import { authorize, authorizeAccount } from "./authorize";
import type { OrgOwners } from "./orgs";
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

/** A route-only capability: the scope a set of routes needs, declared once with the `requires` shape a tool contract uses. */
export interface RouteOnlyCapability {
  readonly requires: ToolRequires;
  readonly routes: readonly string[];
}

/** tool id -> the agent-reachable write routes that carry the same scope. */
export const SAME_DOOR_ROUTES: Readonly<Record<string, SameDoorRoute>> = {
  core__work_item_update: {
    scope: "work_item:transition",
    // One scope covers the whole work-item lifecycle an agent drives: file (create), take (claim), give back (release), keep alive (heartbeat), and change (patch).
    routes: ["work.items.patch", "work.items.create", "work.items.claim", "work.items.release", "work.items.heartbeat"],
  },
  // The artifact write rides the same door: one scope, no review grant (task.0028, task.0122).
  core__work_item_artifact_record: {
    scope: "work_item:transition",
    routes: ["work.items.artifacts.create"],
  },
  core__schedule_manage: {
    scope: "schedule:manage",
    routes: ["schedules.create", "schedules.update", "schedules.delete"],
  },
  core__edo_hypothesize: { scope: "edo:write", routes: ["edo.hypothesize"] },
  core__edo_decide: { scope: "edo:write", routes: ["edo.decide"] },
  core__edo_record_outcome: { scope: "edo:write", routes: ["edo.record_outcome"] },
  core__metric_compute: { scope: "metric:compute", routes: ["metrics.metricCompute"] },
  // A READ tool with an account scope (task.5465): the route twins of the ONE account scope (`account:read`, "Read your account data"): the account-keyed credits read, and the credits summary when it names an account. An agent needs a live account row for the exact account.
  core__account_credits_read: { scope: "account:read", routes: ["accounts.credits.read", "payments.credits_summary"] },
};

/**
 * Routes an outside agent may call that no tool twins (writes, and the knowledge reads). They declare their own scope here, once, with the same
 * `requires` shape a tool contract uses. A signed-in human passes `member`; a bearer agent needs a live role row.
 */
export const ROUTE_ONLY_CAPABILITIES: Readonly<Record<string, RouteOnlyCapability>> = {
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
      // An external agent registers the domain its contribution needs (domain register is behind this scope: a bearer needs knowledge:contribute), so it holds the same scope as the contribution itself.
      "knowledge.domains.create",
    ],
  },
};

/** Tools that have no node route, with the reason. A new tool must be added here or to `SAME_DOOR_ROUTES`. */
export const NO_ROUTE_TWIN: Readonly<Record<string, string>> = {
  // These call the operator's API with the node's identity; the operator's own deploy roles (operator OpenFGA) gate them.
  // The tool writes straight to main. Its true twin (a direct-to-main knowledge write route) deliberately does not
  // exist: the node route an outside agent uses is the contribution proposal (`knowledge.contribute`). Whether the tool
  // should write contributions instead of main is a design question (C2, task.5465).
  core__knowledge_write: "no direct-to-main write route exists on purpose; outside agents use knowledge.contribute",
  core__sandbox_shell: "runs a command in the node's own sandbox lease; no node route twins a shell",
  core__vcs_create_branch: "calls the operator VCS API, not a node route",
  core__vcs_merge_pr: "calls the operator VCS API, not a node route",
  core__vcs_flight_candidate: "calls the operator VCS API, not a node route",
};

/**
 * Write routes on this node that sit next to a gated capability but are NOT the same capability, so they carry no
 * door yet. A bearer agent is refused on each: the route wrapper's DENY_BY_DEFAULT answers 403 `bearer_write_undeclared` (bug.0045). Each names the design item that decides it. The route enumeration test (app/tests/unit/app/same-door-routes.test.ts)
 * fails when a write handler under the work, schedules, edo, knowledge or metrics routes is in neither this list nor
 * `SAME_DOOR_ROUTES` / `ROUTE_ONLY_CAPABILITIES`.
 */
export const DEFERRED_WRITE_ROUTES: Readonly<Record<string, string>> = {
  "work.items.delete": "retired (HTTP 410); no capability to gate",
  "knowledge.domains.update": "domain registry writes; C2 design question (task.5465); a bearer is refused by deny-by-default (bug.0045)",
  "knowledge.domains.delete": "domain registry writes; C2 design question (task.5465); a bearer is refused by deny-by-default (bug.0045)",
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

/**
 * What a node adds to the baseline above (NODE_ADDS_ONLY). The same three maps, each keyed as its constant is. A key the package already holds, a route id
 * two entries claim, or a tool that is both twinned and exempt throws in `composeAgentRoutes`. A node never replaces a baseline entry.
 */
export interface AgentRoutes {
  /** Tool id -> its route twins, for a tool the node adds. */
  readonly sameDoorRoutes?: Readonly<Record<string, SameDoorRoute>> | undefined;
  /** Capability id -> the scope and routes of a route no tool twins. */
  readonly routeOnlyCapabilities?: Readonly<Record<string, RouteOnlyCapability>> | undefined;
  /** Tool id -> why the tool has no node route. */
  readonly noRouteTwin?: Readonly<Record<string, string>> | undefined;
}

/** The package baseline plus a node's additions: what the catalog, the ask door and `authorizeRoute` read. */
export interface ComposedRoutes {
  readonly sameDoorRoutes: Readonly<Record<string, SameDoorRoute>>;
  readonly routeOnlyCapabilities: Readonly<Record<string, RouteOnlyCapability>>;
  readonly noRouteTwin: Readonly<Record<string, string>>;
}

function addOnly<T>(what: string, base: Readonly<Record<string, T>>, extra: Readonly<Record<string, T>> | undefined): Record<string, T> {
  const out: Record<string, T> = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key in out) throw new Error(`ROUTE_COLLISION: ${what} "${key}" is already declared; a node adds, it never replaces`);
    out[key] = value;
  }
  return out;
}

/**
 * The one composition of the baseline route maps with a node's additions. Throws (a collision is a build error, not a log line) when a node entry reuses a
 * baseline key, when a tool is both twinned and exempt, or when one route id sits under two entries (one route, two scopes is never a door).
 */
export function composeAgentRoutes(extra?: AgentRoutes): ComposedRoutes {
  const sameDoorRoutes = addOnly("route twin for tool", SAME_DOOR_ROUTES, extra?.sameDoorRoutes);
  const routeOnlyCapabilities = addOnly("route-only capability", ROUTE_ONLY_CAPABILITIES, extra?.routeOnlyCapabilities);
  const noRouteTwin = addOnly("no-route-twin tool", NO_ROUTE_TWIN, extra?.noRouteTwin);
  for (const tool of Object.keys(noRouteTwin))
    if (tool in sameDoorRoutes) throw new Error(`ROUTE_COLLISION: tool "${tool}" has a route twin and is also listed as having none`);
  const owner = new Map<string, string>();
  for (const [key, entry] of [...Object.entries(sameDoorRoutes), ...Object.entries(routeOnlyCapabilities)])
    for (const routeId of entry.routes) {
      const prior = owner.get(routeId);
      if (prior !== undefined && prior !== key) throw new Error(`ROUTE_COLLISION: route "${routeId}" is declared by both "${prior}" and "${key}"`);
      owner.set(routeId, key);
    }
  return { sameDoorRoutes, routeOnlyCapabilities, noRouteTwin };
}

/** Methods that only read. Every other method is a write for DENY_BY_DEFAULT. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface BearerWriteInput {
  /** The request's HTTP method. */
  readonly method: string;
  /** How the request authenticated. Fail closed: anything but `session` is treated as a bearer. */
  readonly via: "bearer" | "session";
  /** True only when the route's `sameDoor` check will actually run for this request (a skipped optional query door does not count). */
  readonly doorRuns: boolean;
  /** The route's `bearerWrite` reason (a route that touches only the caller's own data), if it declared one. */
  readonly bearerWrite?: string | undefined;
  /** The route's id, matched against `OPEN_BY_DESIGN_ROUTES`. */
  readonly routeId: string;
}

/**
 * DENY_BY_DEFAULT (bug.0045): the one pure decision a node's route wrapper calls before the handler. A bearer write (any method but GET, HEAD, OPTIONS)
 * needs a door that runs, a `bearerWrite` reason, or an `OPEN_BY_DESIGN_ROUTES` entry; anything else is refused with `bearer_write_undeclared`
 * (the node answers 403). A human session and every read pass. Returns `null` to let the request go on.
 */
export function bearerWriteRefusal(input: BearerWriteInput): null | { readonly code: "bearer_write_undeclared" } {
  if (input.via === "session") return null;
  if (SAFE_METHODS.has(input.method.toUpperCase())) return null;
  if (input.doorRuns) return null;
  if (input.bearerWrite) return null;
  if (input.routeId in OPEN_BY_DESIGN_ROUTES) return null;
  return { code: "bearer_write_undeclared" };
}

export interface CallerInput {
  readonly userId: string;
  /** How the request authenticated. `bearer` is an AI on the AI plane; `session` is a human. */
  readonly via: "bearer" | "session";
  readonly requires: ToolRequires;
  /** The account the request names. Required for an `account` scope: no account is a deny. */
  readonly accountId?: string | undefined;
  /** Owner sources (0.8.0): an account owned by an org is also `owner` to each of the org's owners. */
  readonly owners?: OrgOwners | undefined;
}

/** The route door. Same `authorize()` for a bearer (its own principal); subject rules only for a human. */
export async function authorizeCaller(
  store: AgentGrantsStore,
  adminCheck: AdminCheck,
  input: CallerInput
): Promise<AuthzDecision> {
  const { userId, via, requires } = input;
  if (requires.kind === "account") {
    // ONE_ACCOUNT_DOOR: the owner, or a bearer agent with a live row for this scope and this exact account; everything else is one deny.
    if (!input.accountId) return { decision: "deny", code: "policy_denied", reason: "no_account" };
    const access = await authorizeAccount(store, {
      callerUserId: userId,
      via,
      scope: requires.scope,
      accountId: input.accountId,
      owners: input.owners,
    });
    return access
      ? { decision: "allow", basis: access }
      : { decision: "deny", code: "policy_denied", reason: "no_account_access" };
  }
  if (via === "bearer") {
    // The bearer IS the principal. `own` data belongs to it, so it is also the subject there. An `admin`-subject scope
    // runs the one admin check on the bearer's own bound wallet (ONE_ADMIN_CHECK), never a pass on the role row alone.
    return authorize(store, adminCheck, {
      principalId: userId,
      subjectUserId: requires.kind === "own" ? userId : undefined,
      requires,
    });
  }
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
