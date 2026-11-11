// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-authority`
 * Purpose: This node's wiring of `@cogni-dao/agent-grants`: principal lookup, the guard's store and admin check,
 *   the decision log, and the role grant/revoke the admin route calls.
 * Scope: Composition only. Takes the service-role (BYPASSRLS) postgres.js client from the container: `agent_roles` and
 *   `agent_principals` are deny-all for the app role. Does not decide anything itself (ONE_AUTHORIZE_FN lives in the package).
 * Invariants:
 *   - ADMIN_FROM_USER_BINDINGS: the human's wallet(s) come from `user_bindings` (provider = wallet), never from the
 *     request. Any bound admin wallet passes; no wallet is denied; no configured admins is unavailable.
 *   - AGENTS_HOLD_NO_WALLET (a payout guard, not an authority rule): an agent user has no wallet binding, so today it fails `adminCheck`.
 *     Admin is any principal the DAO approves (AUTHORITY_IS_NOT_KIND); an approved AI identity is item I2, so none passes yet.
 *   - KEYS_ROW_IS_NOT_A_SCOPE: the admin table's `agent:keys` rows (stop and lift) come from the credential store, never from the declarations; the
 *     scope never enters `declaredScopes`, `askableScopes`, `agent_roles` or `hasRoles`.
 *   - DECLARED_SCOPES_FROM_CONTRACTS: the scopes a role may name are exactly those the node's tool contracts declare.
 *   - NO_SECRETS_IN_LOGS: `agent_tool.authz` carries ids, tool, decision and code only.
 * Side-effects: IO (service-role database reads and writes)
 * Links: packages/agent-grants, https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import {
  type AdminCheck,
  agentNameKey,
  type AuthzDecision,
  authorizeCaller,
  ROUTE_ONLY_CAPABILITIES,
  SAME_DOOR_ROUTES,
  type AuthzEvent,
  createPostgresAgentGrantsStore,
  buildNodeAiView,
  type GuardDeps,
  denyRequest,
  grantRole,
  listOwnAccess,
  type PrincipalRef,
  requestAccess,
  type RoleState,
  type NodeAiPermissionView,
  resolveInternalPrincipal,
  revokeRole,
  type SqlTag,
  type ToolRequires,
  type WithStore,
} from "@cogni/agent-grants";
import {
  agentRolesHasRoles,
  type CredentialSql,
  type CredentialStore,
  createPostgresCredentialStore,
} from "@cogni/agent-grants/credentials";
import type { CatalogBoundTool } from "@cogni/ai-tools";
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import type { NodeAdminAuthority } from "@cogni/knowledge-store";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";

/** The service-role postgres.js client (`serviceDb.$client`): a tagged template that can also open a transaction. */
export interface AgentAuthoritySql extends SqlTag {
  begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T>;
}

export interface AgentToolAuthority {
  /** The seeded user id for a catalog principal slug, or null when no row exists (the run is then denied). */
  resolvePrincipal(slug: string): Promise<string | null>;
  /** Guard dependencies. `runAs` is supplied by the provider, which owns the ExecutionScope. */
  readonly guardDeps: Omit<GuardDeps, "runAs">;
  /** Scopes a role may name. */
  readonly declaredScopes: readonly string[];
  /** Turn a row ON: approve a pending ask, or grant one of this node's AI directly. */
  grantRole(
    input: PrincipalRef & { scope: string; approvedBy: string }
  ): Promise<{ principalUserId: string; created: boolean }>;
  /** Turn a live row OFF. */
  revokeRole(
    input: PrincipalRef & { scope: string; revokedBy: string }
  ): Promise<{ principalUserId: string; revoked: boolean }>;
  /** Dismiss a pending ask (the agent then sees `denied`). */
  denyRequest(
    input: PrincipalRef & { scope: string; deniedBy: string }
  ): Promise<{ principalUserId: string; denied: boolean }>;
  /** An agent asks for a scope for itself (a pending row, no approver). Idempotent. Throws AgentRolesError on a bad scope or too many asks. */
  requestAccess(input: {
    principalUserId: string;
    scope: string;
  }): Promise<{ state: "pending" | "granted"; created: boolean }>;
  /**
   * True when `name` matches (case, spacing and look-alike forms ignored) any user's name or any of this node's AI slugs. Used at
   * registration so an outside agent cannot take a name that looks like this node's AI on the screen where an admin says yes.
   */
  nameTaken(name: string): Promise<boolean>;
  /** The agent's own rows by state. */
  listOwnAccess(principalUserId: string): Promise<Array<{ scope: string; state: RoleState; at: string }>>;
  /**
   * The admin table: one row per grant row, in three blocks. Name and description come from the declarations only.
   * Outside rows are bounded (`MAX_ADMIN_OUTSIDE_ROWS`); `more` counts the ones cut.
   */
  listNodeAi(): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  /** The same admin check the guard uses, for the role routes. */
  readonly adminCheck: AdminCheck;
  /**
   * SAME_DOOR: the route twin of a guarded tool. A bearer caller is its own principal and needs a live role row; a human
   * session passes the subject rules. Logs `agent_tool.authz` with the route id. A tool with no declared `requires` is denied.
   */
  authorizeRoute(input: {
    toolId: string;
    routeId: string;
    userId: string;
    via: "bearer" | "session";
  }): Promise<AuthzDecision>;
}

/** `requiresById` from the contracts the node already loads. */
export function buildRequiresById(
  bundle: readonly CatalogBoundTool[]
): Record<string, ToolRequires> {
  const byId: Record<string, ToolRequires> = {};
  for (const tool of bundle) {
    if (tool.contract.requires) byId[tool.contract.name] = tool.contract.requires;
  }
  return byId;
}

/** Wallet-bound admin check: any bound wallet that is a node admin passes. */
export function createAdminCheck(
  sql: SqlTag,
  nodeAdmin: NodeAdminAuthority
): AdminCheck {
  return async (subjectUserId) => {
    const rows = (await sql`
      SELECT external_id FROM user_bindings
      WHERE user_id = ${subjectUserId} AND provider = 'wallet'`) as ReadonlyArray<{
      external_id: string;
    }>;
    if (rows.length === 0) {
      // No wallet is denied; but report an unconfigured node as unavailable, never as a plain deny.
      const probe = await nodeAdmin.check({ userId: subjectUserId });
      return !probe.ok && probe.errorCode === "authz_unavailable"
        ? "unavailable"
        : "denied";
    }
    for (const row of rows) {
      const decision = await nodeAdmin.check({
        userId: subjectUserId,
        walletAddress: row.external_id,
      });
      if (decision.ok) return "allow";
      if (decision.errorCode === "authz_unavailable") return "unavailable";
    }
    return "denied";
  };
}

/**
 * The admin read has TWO bounds, so a table of any size stays one bounded response:
 * - `MAX_ADMIN_OUTSIDE_ROWS` role rows of outside agents (pending asks first), unchanged.
 * - `MAX_ADMIN_KEY_ROWS` keys rows (`agent:keys`: one per outside agent that holds a sign-in key or is stopped), on top.
 * So the response holds at most this node's own AI in full plus 150 outside rows. `more` is the sum of what both reads cut.
 */
export const MAX_ADMIN_OUTSIDE_ROWS = 100;
export const MAX_ADMIN_KEY_ROWS = 50;

export function createAgentToolAuthority(deps: {
  sql: AgentAuthoritySql;
  nodeAdmin: NodeAdminAuthority;
  log: Logger;
  toolBundle: readonly CatalogBoundTool[];
}): AgentToolAuthority {
  const requiresById = buildRequiresById(deps.toolBundle);
  // Declared once, shown everywhere: every tool contract's `requires` plus every route-only capability.
  const declarations: Record<string, { label?: string | undefined; description?: string | undefined }> = {};
  for (const r of Object.values(requiresById))
    declarations[r.scope] = { label: r.label, description: r.description };
  for (const cap of Object.values(ROUTE_ONLY_CAPABILITIES))
    declarations[cap.requires.scope] = {
      label: cap.requires.label,
      description: cap.requires.description,
    };
  const declaredScopes = Object.keys(declarations).sort();
  // The scopes an outside agent can actually use: a route twin it can call. An ask for any other scope would be an approvable
  // row that opens nothing, so it is refused up front.
  const askableScopes = [
    ...new Set([
      ...Object.values(SAME_DOOR_ROUTES).map((r) => r.scope),
      ...Object.values(ROUTE_ONLY_CAPABILITIES).map((c) => c.requires.scope),
    ]),
  ].sort();
  const adminCheck = createAdminCheck(deps.sql, deps.nodeAdmin);
  // The keys rows read the credential store (a bounded `listKeyHolders`). Built lazily on the same service-role client.
  let keyStore: CredentialStore | undefined;
  const credentialStore = (): CredentialStore =>
    (keyStore ??= createPostgresCredentialStore(deps.sql as unknown as CredentialSql, { hasRoles: agentRolesHasRoles(deps.sql) }));

  // One transaction per call, so a role read sees one consistent snapshot.
  const withStore: WithStore = (fn) =>
    deps.sql.begin((tx) => fn(createPostgresAgentGrantsStore(tx)));

  const onDecision = (event: AuthzEvent): void => {
    const level = event.decision === "allow" ? "info" : "warn";
    deps.log[level](
      { event: EVENT_NAMES.AGENT_TOOL_AUTHZ, ...event },
      EVENT_NAMES.AGENT_TOOL_AUTHZ
    );
  };

  return {
    resolvePrincipal: (slug) => withStore((store) => resolveInternalPrincipal(store, slug)),
    guardDeps: { withStore, adminCheck, onDecision },
    async listNodeAi() {
      // The scopes each AI may use come from the contracts of every tool its graphs list.
      const scopesByPrincipal: Record<string, string[]> = {};
      for (const entry of Object.values(LANGGRAPH_CATALOG)) {
        if (!entry.principal) continue;
        const scopes = (scopesByPrincipal[entry.principal] ??= []);
        for (const toolId of entry.toolIds) {
          const requires = requiresById[toolId];
          if (requires) scopes.push(requires.scope);
        }
      }
      const { internal, listed } = await withStore(async (store) => ({
        internal: await store.listInternalPrincipals(),
        listed: await store.listRoleRows(MAX_ADMIN_OUTSIDE_ROWS),
      }));
      // `agent:keys` rows (task.0091): not a declared scope, so they come from the credential store, never from `declarations`.
      const keys = await credentialStore().listKeyHolders(MAX_ADMIN_KEY_ROWS);
      return {
        permissions: buildNodeAiView({ declarations, scopesByPrincipal, internal, rows: listed.rows, keyHolders: keys.holders }),
        more: listed.more + keys.more,
      };
    },
    declaredScopes,
    adminCheck,
    async authorizeRoute({ toolId, routeId, userId, via }) {
      const requires =
        requiresById[toolId] ?? ROUTE_ONLY_CAPABILITIES[toolId]?.requires;
      const decision: AuthzDecision = !requires
        ? { decision: "deny", code: "policy_denied", reason: "no_requires" }
        : await withStore((store) =>
            authorizeCaller(store, adminCheck, { userId, via, requires })
          ).catch(
            (): AuthzDecision => ({
              decision: "deny",
              code: "authz_unavailable",
              reason: "store_unavailable",
            })
          );
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
      });
      return decision;
    },
    async grantRole(input) {
      const result = await withStore((store) =>
        grantRole(store, { ...input, declaredScopes })
      );
      if (result.created)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_GRANTED,
            principalUserId: result.principalUserId,
            scope: input.scope,
            approvedBy: input.approvedBy,
          },
          EVENT_NAMES.AGENT_ROLE_GRANTED
        );
      return result;
    },
    async revokeRole(input) {
      const result = await withStore((store) =>
        revokeRole(store, {
          ...(input.principalSlug !== undefined
            ? { principalSlug: input.principalSlug }
            : { principalUserId: input.principalUserId as string }),
          scope: input.scope,
        })
      );
      if (result.revoked)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_REVOKED,
            principalUserId: result.principalUserId,
            scope: input.scope,
            revokedBy: input.revokedBy,
          },
          EVENT_NAMES.AGENT_ROLE_REVOKED
        );
      return result;
    },
    async denyRequest(input) {
      const result = await withStore((store) =>
        denyRequest(store, {
          ...(input.principalSlug !== undefined
            ? { principalSlug: input.principalSlug }
            : { principalUserId: input.principalUserId as string }),
          scope: input.scope,
        })
      );
      if (result.denied)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_DENIED,
            principalUserId: result.principalUserId,
            scope: input.scope,
            deniedBy: input.deniedBy,
          },
          EVENT_NAMES.AGENT_ROLE_DENIED
        );
      return result;
    },
    async requestAccess(input) {
      const result = await withStore((store) =>
        requestAccess(store, { ...input, declaredScopes, askableScopes })
      );
      if (result.created)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_REQUESTED,
            principalUserId: input.principalUserId,
            scope: input.scope,
          },
          EVENT_NAMES.AGENT_ROLE_REQUESTED
        );
      return result;
    },
    async nameTaken(name) {
      const key = agentNameKey(name);
      if (!key) return true;
      // POSIX classes, not \s: a tagged template cooks backslashes away. This node's AI are identified by slug (their users row
      // carries the slug as its name too), so comparing against both covers them.
      const rows = await deps.sql`
        SELECT 1 AS taken FROM users
        WHERE lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = ${key}
        UNION ALL
        SELECT 1 AS taken FROM agent_principals
        WHERE lower(regexp_replace(btrim(slug), '[[:space:]]+', ' ', 'g')) = ${key}
        LIMIT 1`;
      return rows.length > 0;
    },
    listOwnAccess: (principalUserId) =>
      withStore((store) => listOwnAccess(store, principalUserId)),
  };
}
