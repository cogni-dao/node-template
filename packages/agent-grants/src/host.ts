// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/host`
 * Purpose: A node's wiring of this package, written once (task.0175): the store wrapper, the guard's decision log, the admin check over wallet bindings,
 *   and the role, ask and mine calls. A node passes its SQL client, its admin authority, its logger and its tool contracts, and gets one authority object.
 * Scope: Composition over this package's own functions. The first release has no org, service-auth or payer methods; they join `createAgentToolAuthority`
 *   after task.0181 (agent-grants 0.10.0). Takes a connection that bypasses row-level security: `agent_roles` and `agent_principals` are deny-all for the app
 *   role. Decides nothing itself (ONE_AUTHORIZE_FN lives in `./authorize`).
 * Invariants:
 *   - ADMIN_FROM_USER_BINDINGS: the human's wallet(s) come from `user_bindings` (provider = wallet), never from the request. Any bound admin wallet passes;
 *     no wallet is denied; no configured admins is unavailable.
 *   - DECLARED_SCOPES_FROM_CONTRACTS: the scopes a role may name are exactly those the node's tool contracts declare (`buildPermissionCatalog`).
 *   - NO_SECRETS_IN_LOGS: `agent_tool.authz` carries ids, tool, decision and code only.
 *   - EVENT_NAMES_HERE: `AGENT_HOST_EVENTS` owns the event names; a node's registry repeats them only as these values (a parity test pins it).
 *   - PORT_MEANS_INTERFACE: `NodeAdminCheckPort` and `HostLog` are interfaces the node implements; this file imports no logger, no node table and no ai-tools.
 * Side-effects: IO (database reads and writes through the injected client), log lines through the injected logger
 * Links: https://node-template.cognidao.org/knowledge/agent-run-authority
 * @public
 */

import { type MineListInput, listMine, scopesByPrincipalOf, turnMineOff, turnMineOn } from "./account-access";
import type { ApprovalCaller } from "./approval";
import { authorizeCaller, ROUTE_ONLY_CAPABILITIES, SAME_DOOR_ROUTES } from "./same-door";
import { buildAskView, buildNodeAiView } from "./node-ai";
import type { OrgOwners } from "./orgs";
import { agentNameKey } from "./names";
import { createPostgresAgentGrantsStore, type SqlTag } from "./postgres";
import {
  classifyPrincipal,
  type PrincipalClass,
  type PrincipalKind,
  principalKindOf,
  writeExternalPrincipal,
} from "./principals";
import {
  AgentRolesError,
  type AskOutcome,
  denyRequest,
  grantRole,
  listOwnAccess,
  type PrincipalRef,
  previewAsk,
  requestAccess,
  resolveInternalPrincipal,
  revokeRole,
} from "./roles";
import type {
  AdminCheck,
  AuthzDecision,
  AuthzEvent,
  GrantResource,
  NodeAiPermissionView,
  RoleState,
  ScopeKind,
  ToolRequires,
  WithStore,
} from "./types";
import type { GuardDeps } from "./guard";

/** The event names this module logs under. A node's registry repeats them only as these values. */
export const AGENT_HOST_EVENTS = {
  toolAuthz: "agent_tool.authz",
  roleGranted: "agent_role.granted",
  roleRevoked: "agent_role.revoked",
  roleRequested: "agent_role.requested",
  roleDenied: "agent_role.denied",
  rolesUnavailable: "agent.roles.unavailable",
} as const;

/** The logger surface the host uses: pino's `info`, `warn` and `error` with `(fields, event)`. */
export interface HostLog {
  info(fields: Record<string, unknown>, event: string): void;
  warn(fields: Record<string, unknown>, event: string): void;
  error(fields: Record<string, unknown>, event: string): void;
}

/** The node's admin authority, as the admin check reads it: one wallet at a time, by the DAO's repo-spec list. */
export interface NodeAdminCheckPort {
  check(input: { userId: string; walletAddress?: string }): Promise<{ ok: true } | { ok: false; errorCode: string }>;
}

/** The service-role postgres.js client: a tagged template that can also open a transaction. */
export interface AgentAuthoritySql extends SqlTag {
  begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T>;
}

/** What the host reads of a tool contract: its id and its declared `requires`. A node maps its contracts to this shape. */
export interface RequiresRecord {
  readonly id: string;
  readonly requires?: ToolRequires | undefined;
}

export interface PermissionDeclaration {
  readonly label?: string | undefined;
  readonly description?: string | undefined;
}

export interface GrantablePermission {
  readonly scope: string;
  readonly label: string;
  readonly description: string;
  readonly kind: ScopeKind;
}

export interface PermissionCatalog {
  readonly declarations: Readonly<Record<string, PermissionDeclaration>>;
  /** The declared kind of every scope: it picks the resource (account or node), the approver and the page the approval link opens. */
  readonly scopeKinds: Readonly<Record<string, ScopeKind>>;
  readonly declaredScopes: readonly string[];
  readonly askableScopes: readonly string[];
  /** Askable scopes with a name and description, by scope. What discovery shows. */
  readonly permissions: readonly GrantablePermission[];
}

/** `requiresById` from the `{ id, requires }` records of the contracts the node already loads. */
export function buildRequiresById(records: readonly RequiresRecord[]): Record<string, ToolRequires> {
  const byId: Record<string, ToolRequires> = {};
  for (const record of records) if (record.requires) byId[record.id] = record.requires;
  return byId;
}

/**
 * The one derivation of a node's permission catalog from its declarations. The role routes (`declaredScopes`), the ask door (`askableScopes`) and agent
 * discovery (`permissions`) all read it. DECLARED_ONCE_SHOWN_EVERYWHERE: a scope with no label and description is not shown. ASKABLE_IS_REACHABLE: an
 * outside agent can ask only for a scope a route twin uses.
 */
export function buildPermissionCatalog(requiresById: Readonly<Record<string, ToolRequires>>): PermissionCatalog {
  const requires: Record<string, ToolRequires> = {};
  for (const r of Object.values(requiresById)) requires[r.scope] = r;
  for (const cap of Object.values(ROUTE_ONLY_CAPABILITIES)) requires[cap.requires.scope] = cap.requires;

  const declarations: Record<string, PermissionDeclaration> = {};
  const scopeKinds: Record<string, ScopeKind> = {};
  for (const r of Object.values(requires)) {
    declarations[r.scope] = { label: r.label, description: r.description };
    scopeKinds[r.scope] = r.kind;
  }
  const declaredScopes = Object.keys(declarations).sort();
  const askableScopes = [
    ...new Set([
      ...Object.values(SAME_DOOR_ROUTES).map((r) => r.scope),
      ...Object.values(ROUTE_ONLY_CAPABILITIES).map((c) => c.requires.scope),
    ]),
  ].sort();
  const permissions = askableScopes.flatMap((scope) => {
    const r = requires[scope];
    return r?.label && r.description ? [{ scope, label: r.label, description: r.description, kind: r.kind }] : [];
  });
  return { declarations, scopeKinds, declaredScopes, askableScopes, permissions };
}

/** The admin check over wallet bindings: any bound wallet the DAO lists passes; none is denied; an unconfigured roster is unavailable. */
export function createAdminCheck(sql: SqlTag, nodeAdmin: NodeAdminCheckPort): AdminCheck {
  return async (subjectUserId) => {
    const rows = (await sql`
      SELECT external_id FROM user_bindings
      WHERE user_id = ${subjectUserId} AND provider = 'wallet'
      ORDER BY external_id LIMIT 20`) as ReadonlyArray<{ external_id: string }>;
    if (rows.length === 0) {
      // No wallet: the roster decides on the user id alone (a node with no configured admins answers unavailable).
      const probe = await nodeAdmin.check({ userId: subjectUserId });
      return !probe.ok && probe.errorCode === "authz_unavailable" ? "unavailable" : "denied";
    }
    for (const row of rows) {
      const decision = await nodeAdmin.check({ userId: subjectUserId, walletAddress: row.external_id });
      if (decision.ok) return "allow";
      if (decision.errorCode === "authz_unavailable") return "unavailable";
    }
    return "denied";
  };
}

/** The most outside-agent rows the admin table lists (the rest is `more`). */
export const MAX_ADMIN_OUTSIDE_ROWS = 100;

export interface AgentToolAuthority {
  /** The seeded user id for a catalog principal slug, or null when no row exists (the run is then denied). */
  resolvePrincipal(slug: string): Promise<string | null>;
  /** Guard dependencies. `runAs` is supplied by the provider, which owns the run scope. */
  readonly guardDeps: Omit<GuardDeps, "runAs">;
  /** Scopes a role may name. */
  readonly declaredScopes: readonly string[];
  /** The permissions an outside agent may ask for, with the names discovery shows. */
  readonly permissions: PermissionCatalog["permissions"];
  /** The declared kind of every scope (it picks the resource, the approver and the page the approval link opens). */
  readonly scopeKinds: Readonly<Record<string, ScopeKind>>;
  /** Turn a NODE row ON: approve a pending ask, or grant one of this node's AI directly. `me.admin` is the admin session (ONE_GATE). */
  grantRole(input: PrincipalRef & { scope: string; me: ApprovalCaller }): Promise<{ principalUserId: string; created: boolean }>;
  /** Turn a live NODE row OFF. */
  revokeRole(input: PrincipalRef & { scope: string; me: ApprovalCaller }): Promise<{ principalUserId: string; revoked: boolean }>;
  /** Dismiss a pending NODE ask (the agent then sees `denied`). */
  denyRequest(input: PrincipalRef & { scope: string; me: ApprovalCaller }): Promise<{ principalUserId: string; denied: boolean }>;
  /** An agent asks for a scope for itself (a pending row, no approver) and gets one one-time link path. Throws AgentRolesError on a bad scope or too many asks. */
  requestAccess(input: { principalUserId: string; scope: string }): Promise<AskOutcome>;
  /** The waiting ask a link token opens on this page's resource, as a table row; null for any unusable token (one non-disclosing answer). */
  previewAsk(input: { token: string; resource: GrantResource }): Promise<NodeAiPermissionView | null>;
  /** The profile table for ONE person: their live account rows, this node's AI Off until On, and no node rows. */
  listMine(userId: string): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  /** The person turns an ACCOUNT row On: an outside AI's ask by its token, or this node's AI directly. The person's account is created if absent. */
  turnMineOn(
    me: ApprovalCaller,
    input: { token: string; accountId?: string | undefined } | { principalUserId: string; scope: string }
  ): Promise<{ changed: boolean }>;
  /** The person turns a live ACCOUNT row Off by id, or dismisses a waiting ask by its token. */
  turnMineOff(me: ApprovalCaller, input: { rowId: string } | { token: string; accountId?: string | undefined }): Promise<{ changed: boolean }>;
  /** Is this registered name taken (a user name or an internal slug)? */
  nameTaken(name: string): Promise<boolean>;
  /** Register an outside agent: its `users` row and its `external` principal row, in one transaction. */
  registerAgent(input: { userId: string; name: string }): Promise<void>;
  principalKind(userId: string): Promise<PrincipalKind>;
  /** The one classifier of a write's actor (internal, external, human, system, unclassified). */
  principalClass(userId: string): Promise<PrincipalClass>;
  boundWallets(userId: string): Promise<string[]>;
  listOwnAccess(principalUserId: string): Promise<Array<{ scope: string; state: RoleState; at: string; accountId: string | null }>>;
  /** The table for the admin page: this node's AI and outside agents with rows. */
  listNodeAi(): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  readonly adminCheck: AdminCheck;
  /** SAME_DOOR: the route's own decision, logged like a tool's. */
  authorizeRoute(input: {
    toolId: string;
    routeId: string;
    userId: string;
    via: "bearer" | "session";
    accountId?: string;
  }): Promise<AuthzDecision>;
  /** The decision log and store wrapper the node's extensions (org, payer, service) reuse until they join the package. */
  readonly withStore: WithStore;
  readonly declarations: PermissionCatalog["declarations"];
  readonly askableScopes: readonly string[];
}

export interface AgentToolAuthorityDeps {
  readonly sql: AgentAuthoritySql;
  readonly nodeAdmin: NodeAdminCheckPort;
  readonly log: HostLog;
  /** The node's tool contracts as `{ id, requires }` records. */
  readonly tools: readonly RequiresRecord[];
  /** The node's graph catalog entries (`principal`, `toolIds`), for the table of which AI may use which scope. */
  readonly graphs: Iterable<{ readonly principal?: string | undefined; readonly toolIds: readonly string[] }>;
  /** The system principal ids `principalClass` calls `system`. */
  readonly systemUserIds: readonly string[];
  /** Create the person's billing account when they turn an account row On and have none yet. */
  readonly ensureBillingAccount?: ((userId: string) => Promise<string>) | undefined;
  /** The owner source for org accounts; absent means every account is owned by its owner user alone. */
  readonly owners?: OrgOwners | undefined;
  /** The node's failure-class fields for an unavailable-store log (name, SQLSTATE, never a message). */
  readonly failureFields?: ((error: unknown) => object) | undefined;
}

export function createAgentToolAuthority(deps: AgentToolAuthorityDeps): AgentToolAuthority {
  const requiresById = buildRequiresById(deps.tools);
  const { declarations, scopeKinds, declaredScopes, askableScopes, permissions } = buildPermissionCatalog(requiresById);
  const graphs = [...deps.graphs];
  const scopesOf = (plane: "account" | "node") => scopesByPrincipalOf(graphs, requiresById, plane);
  const adminCheck = createAdminCheck(deps.sql, deps.nodeAdmin);
  const failure = deps.failureFields ?? (() => ({}));

  const withStore: WithStore = async (fn) => {
    try {
      return await deps.sql.begin((tx) => fn(createPostgresAgentGrantsStore(tx)));
    } catch (error) {
      if (!(error instanceof AgentRolesError))
        deps.log.error(
          { event: AGENT_HOST_EVENTS.rolesUnavailable, routeId: "agent.authority.store", ...failure(error) },
          AGENT_HOST_EVENTS.rolesUnavailable
        );
      throw error;
    }
  };

  // A read retries once when the connection ended under it (the transaction did not commit), so a recycled connection is no 503.
  const withStoreRead: WithStore = (fn) =>
    withStore(fn).catch((error: unknown) => {
      if (isConnectionLoss(error)) return withStore(fn);
      throw error;
    });

  const onDecision = (event: AuthzEvent): void => {
    const level = event.decision === "allow" ? "info" : "warn";
    deps.log[level]({ event: AGENT_HOST_EVENTS.toolAuthz, ...event }, AGENT_HOST_EVENTS.toolAuthz);
  };

  const principalRef = (input: PrincipalRef) =>
    input.principalSlug !== undefined
      ? { principalSlug: input.principalSlug }
      : { principalUserId: (input as { principalUserId: string }).principalUserId };

  return {
    resolvePrincipal: (slug) => withStore((store) => resolveInternalPrincipal(store, slug)),
    guardDeps: { withStore: withStoreRead, adminCheck, onDecision },
    scopeKinds,
    declaredScopes,
    permissions,
    declarations,
    askableScopes,
    withStore,
    adminCheck,
    async listNodeAi() {
      const scopesByPrincipal = scopesOf("node");
      const { internal, listed } = await withStore(async (store) => ({
        internal: await store.listInternalPrincipals(),
        listed: await store.listRoleRows(MAX_ADMIN_OUTSIDE_ROWS),
      }));
      return {
        permissions: buildNodeAiView({ declarations, scopesByPrincipal, internal, rows: listed.rows }),
        more: listed.more,
      };
    },
    async authorizeRoute({ toolId, routeId, userId, via, accountId }) {
      const requires = requiresById[toolId] ?? ROUTE_ONLY_CAPABILITIES[toolId]?.requires;
      const decision: AuthzDecision = !requires
        ? { decision: "deny", code: "policy_denied", reason: "no_requires" }
        : await withStore((store) =>
            authorizeCaller(store, adminCheck, { userId, via, requires, accountId, owners: deps.owners })
          ).catch((): AuthzDecision => ({ decision: "deny", code: "authz_unavailable", reason: "store_unavailable" }));
      onDecision({
        principal: via === "bearer" ? userId : null,
        subject: via === "session" ? userId : null,
        payer: null,
        tool: toolId,
        decision: decision.decision,
        code: decision.decision === "allow" ? "allowed" : decision.code,
        reason: decision.decision === "allow" ? decision.basis : decision.reason,
        runId: null,
        route: routeId,
        account: accountId ?? null,
      });
      return decision;
    },
    async grantRole(input) {
      const result = await withStore((store) => grantRole(store, { ...input, declaredScopes, scopeKinds }));
      if (result.created)
        deps.log.info(
          {
            event: AGENT_HOST_EVENTS.roleGranted,
            principalUserId: result.principalUserId,
            scope: input.scope,
            resource: "node",
            approvedBy: input.me.userId,
          },
          AGENT_HOST_EVENTS.roleGranted
        );
      return result;
    },
    async revokeRole(input) {
      const result = await withStore((store) =>
        revokeRole(store, { ...principalRef(input), scope: input.scope, me: input.me, scopeKinds })
      );
      if (result.revoked)
        deps.log.info(
          {
            event: AGENT_HOST_EVENTS.roleRevoked,
            principalUserId: result.principalUserId,
            scope: input.scope,
            resource: "node",
            revokedBy: input.me.userId,
          },
          AGENT_HOST_EVENTS.roleRevoked
        );
      return result;
    },
    async denyRequest(input) {
      const result = await withStore((store) =>
        denyRequest(store, { ...principalRef(input), scope: input.scope, me: input.me, scopeKinds })
      );
      if (result.denied)
        deps.log.info(
          {
            event: AGENT_HOST_EVENTS.roleDenied,
            principalUserId: result.principalUserId,
            scope: input.scope,
            resource: "node",
            deniedBy: input.me.userId,
          },
          AGENT_HOST_EVENTS.roleDenied
        );
      return result;
    },
    async requestAccess(input) {
      const result = await withStore((store) =>
        requestAccess(store, { ...input, declaredScopes, askableScopes, scopeKinds })
      );
      if (result.created)
        deps.log.info(
          {
            event: AGENT_HOST_EVENTS.roleRequested,
            principalUserId: input.principalUserId,
            scope: input.scope,
            resource: scopeKinds[input.scope] === "account" ? "account" : "node",
          },
          AGENT_HOST_EVENTS.roleRequested
        );
      return result;
    },
    async previewAsk({ token, resource }) {
      const ask = await withStore((store) => previewAsk(store, { token, resource }));
      return ask ? buildAskView(ask, declarations) : null;
    },
    listMine: (userId) =>
      withStore((store) => listMine(store, { userId, declarations, scopesByPrincipal: scopesOf("account") } satisfies MineListInput)),
    async turnMineOn(me, input) {
      // The orchestration (validate, ensure the person's account, decide) is `turnMineOn`'s; this wrapper wires the account hook and logs.
      const result = await withStore((store) =>
        turnMineOn(store, { me, on: input, declaredScopes, scopeKinds, ensureAccount: deps.ensureBillingAccount, owners: deps.owners })
      );
      if (result.changed)
        deps.log.info(
          {
            event: AGENT_HOST_EVENTS.roleGranted,
            resource: "account",
            via: result.via,
            ...(result.principalUserId ? { principalUserId: result.principalUserId, scope: result.scope } : {}),
            approvedBy: me.userId,
          },
          AGENT_HOST_EVENTS.roleGranted
        );
      return { changed: result.changed };
    },
    async turnMineOff(me, input) {
      const result = await withStore((store) => turnMineOff(store, { me, off: input, owners: deps.owners }));
      if (result.changed) {
        const event = result.via === "row" ? AGENT_HOST_EVENTS.roleRevoked : AGENT_HOST_EVENTS.roleDenied;
        deps.log.info(
          result.via === "row"
            ? { event, resource: "account", revokedBy: me.userId }
            : { event, resource: "account", via: "link", deniedBy: me.userId },
          event
        );
      }
      return { changed: result.changed };
    },
    async nameTaken(name) {
      const key = agentNameKey(name);
      if (!key) return true;
      // POSIX classes, not \s: a tagged template cooks backslashes away. An internal AI is identified by its slug (its users row carries the slug as its name too).
      const rows = await deps.sql`
        SELECT 1 AS taken FROM users
        WHERE lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = ${key}
        UNION ALL
        SELECT 1 AS taken FROM agent_principals
        WHERE lower(regexp_replace(btrim(slug), '[[:space:]]+', ' ', 'g')) = ${key}
        LIMIT 1`;
      return rows.length > 0;
    },
    async registerAgent({ userId, name }) {
      await deps.sql.begin(async (tx) => {
        await tx`INSERT INTO users (id, name) VALUES (${userId}, ${name})`;
        await writeExternalPrincipal(tx, userId);
      });
    },
    principalKind: (userId) => principalKindOf(deps.sql, userId),
    principalClass: (userId) => classifyPrincipal(deps.sql, userId, [...deps.systemUserIds]),
    async boundWallets(userId) {
      const rows = (await deps.sql`
        SELECT external_id FROM user_bindings
        WHERE user_id = ${userId} AND provider = 'wallet'
        ORDER BY external_id LIMIT 20`) as ReadonlyArray<{ external_id: string }>;
      return rows.map((row) => row.external_id);
    },
    listOwnAccess: (principalUserId) => withStore((store) => listOwnAccess(store, principalUserId)),
  };
}

/** postgres.js codes for a connection that ended under a query; the transaction did not commit. */
const CONNECTION_LOSS_CODES = new Set(["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"]);
function isConnectionLoss(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    CONNECTION_LOSS_CODES.has(String((error as { code?: unknown }).code))
  );
}
