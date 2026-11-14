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
 *   - DECLARED_SCOPES_FROM_CONTRACTS: the scopes a role may name are exactly those the node's tool contracts declare.
 *   - NO_SECRETS_IN_LOGS: `agent_tool.authz` carries ids, tool, decision and code only.
 * Side-effects: IO (service-role database reads and writes)
 * Links: packages/agent-grants, https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import {
  type AdminCheck,
  type ApprovalCaller,
  agentNameKey,
  type AskOutcome,
  type AuthzDecision,
  approveAccountAsk,
  authorizeCaller,
  buildAccountAiView,
  buildAskView,
  ROUTE_ONLY_CAPABILITIES,
  type AuthzEvent,
  createPostgresAgentGrantsStore,
  buildNodeAiView,
  denyAccountAsk,
  type GuardDeps,
  type GrantResource,
  denyRequest,
  grantInternalOnAccount,
  grantRole,
  listOwnAccess,
  type PrincipalRef,
  previewAsk,
  requestAccess,
  type RoleState,
  type NodeAiPermissionView,
  resolveInternalPrincipal,
  revokeAccountRow,
  revokeRole,
  type SqlTag,
  type ToolRequires,
  type WithStore,
} from "@cogni/agent-grants";
import type { CatalogBoundTool } from "@cogni/ai-tools";
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import type { NodeAdminAuthority } from "@cogni/knowledge-store";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";
import { buildPermissionCatalog, buildRequiresById } from "./agent-permissions";

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
  /** The declared kind of every scope (it picks the resource, the approver and the page the approval link opens). */
  readonly scopeKinds: Readonly<Record<string, ToolRequires["kind"]>>;
  /** Turn a NODE row ON: approve a pending ask, or grant one of this node's AI directly. `me.admin` is the admin session (ONE_GATE). */
  grantRole(
    input: PrincipalRef & { scope: string; me: ApprovalCaller }
  ): Promise<{ principalUserId: string; created: boolean }>;
  /** Turn a live NODE row OFF. */
  revokeRole(
    input: PrincipalRef & { scope: string; me: ApprovalCaller }
  ): Promise<{ principalUserId: string; revoked: boolean }>;
  /** Dismiss a pending NODE ask (the agent then sees `denied`). */
  denyRequest(
    input: PrincipalRef & { scope: string; me: ApprovalCaller }
  ): Promise<{ principalUserId: string; denied: boolean }>;
  /**
   * An agent asks for a scope for itself (a pending row, no approver) and gets one one-time link path, picked by the scope's declared kind.
   * Idempotent: a waiting row is reported and its link rotated. Throws AgentRolesError on a bad scope or too many asks.
   */
  requestAccess(input: {
    principalUserId: string;
    scope: string;
  }): Promise<AskOutcome>;
  /** The waiting ask a link token opens on this page's resource, as a table row; null for any unusable token (one non-disclosing answer). */
  previewAsk(input: { token: string; resource: GrantResource }): Promise<NodeAiPermissionView | null>;
  /**
   * The profile table for ONE person: the live account rows on their own account (this node's AI and outside agents), this node's AI Off until On,
   * and no node rows. An account that does not exist yet lists no rows.
   */
  listMine(userId: string): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  /** The person turns an ACCOUNT row On: an outside AI's ask by its token, or this node's AI directly. The person's account is created if absent. */
  turnMineOn(
    me: ApprovalCaller,
    input:
      | { token: string; days?: number | undefined }
      | { principalUserId: string; scope: string; days?: number | undefined }
  ): Promise<{ changed: boolean }>;
  /** The person turns a live ACCOUNT row Off by id, or dismisses a waiting ask by its token. */
  turnMineOff(me: ApprovalCaller, input: { rowId: string } | { token: string }): Promise<{ changed: boolean }>;
  /**
   * True when `name` matches (case, spacing and look-alike forms ignored) any user's name or any of this node's AI slugs. Used at
   * registration so an outside agent cannot take a name that looks like this node's AI on the screen where an admin says yes.
   */
  nameTaken(name: string): Promise<boolean>;
  /** The agent's own rows by state. */
  listOwnAccess(
    principalUserId: string
  ): Promise<Array<{ scope: string; state: RoleState; at: string; accountId: string | null }>>;
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
    /** The account the route names. Required for an account-kind tool. */
    accountId?: string;
  }): Promise<AuthzDecision>;
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

/** Outside-agent rows the admin read returns at most (pending asks first). The rest are counted, not sent. */
export const MAX_ADMIN_OUTSIDE_ROWS = 100;

/** Account rows the profile read returns at most (one person's account holds a handful). */
export const MAX_MINE_ROWS = 100;

export function createAgentToolAuthority(deps: {
  sql: AgentAuthoritySql;
  nodeAdmin: NodeAdminAuthority;
  log: Logger;
  toolBundle: readonly CatalogBoundTool[];
  /** The id of the billing account this person owns, created on first use. A person who never opened credits has none until they decide a grant. */
  ensureBillingAccount?: (userId: string) => Promise<string>;
}): AgentToolAuthority {
  const requiresById = buildRequiresById(deps.toolBundle);
  // Declared once, shown everywhere: one derivation feeds the role routes, the ask door and agent discovery.
  const { declarations, scopeKinds, declaredScopes, askableScopes } =
    buildPermissionCatalog(requiresById);
  /** The scopes each of this node's AI may use, split by declared kind: the admin table takes node scopes, the profile table account scopes. */
  const scopesOfCatalog = (account: boolean): Record<string, string[]> => {
    const scopesByPrincipal: Record<string, string[]> = {};
    for (const entry of Object.values(LANGGRAPH_CATALOG)) {
      if (!entry.principal) continue;
      const scopes = (scopesByPrincipal[entry.principal] ??= []);
      for (const toolId of entry.toolIds) {
        const requires = requiresById[toolId];
        if (requires && (requires.kind === "account") === account) scopes.push(requires.scope);
      }
    }
    return scopesByPrincipal;
  };
  const adminCheck = createAdminCheck(deps.sql, deps.nodeAdmin);

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
    scopeKinds,
    async listNodeAi() {
      // The scopes each AI may use come from the contracts of every tool its graphs list. NODE scopes only: an account scope is the person's,
      // and the admin table never shows account rows.
      const scopesByPrincipal = scopesOfCatalog(false);
      const { internal, listed } = await withStore(async (store) => ({
        internal: await store.listInternalPrincipals(),
        listed: await store.listRoleRows(MAX_ADMIN_OUTSIDE_ROWS),
      }));
      return {
        permissions: buildNodeAiView({ declarations, scopesByPrincipal, internal, rows: listed.rows }),
        more: listed.more,
      };
    },
    declaredScopes,
    adminCheck,
    async authorizeRoute({ toolId, routeId, userId, via, accountId }) {
      const requires =
        requiresById[toolId] ?? ROUTE_ONLY_CAPABILITIES[toolId]?.requires;
      const decision: AuthzDecision = !requires
        ? { decision: "deny", code: "policy_denied", reason: "no_requires" }
        : await withStore((store) =>
            authorizeCaller(store, adminCheck, { userId, via, requires, accountId })
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
        account: accountId ?? null,
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
            resource: "node",
            approvedBy: input.me.userId,
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
          me: input.me,
        })
      );
      if (result.revoked)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_REVOKED,
            principalUserId: result.principalUserId,
            scope: input.scope,
            resource: "node",
            revokedBy: input.me.userId,
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
          me: input.me,
        })
      );
      if (result.denied)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_DENIED,
            principalUserId: result.principalUserId,
            scope: input.scope,
            resource: "node",
            deniedBy: input.me.userId,
          },
          EVENT_NAMES.AGENT_ROLE_DENIED
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
            event: EVENT_NAMES.AGENT_ROLE_REQUESTED,
            principalUserId: input.principalUserId,
            scope: input.scope,
            resource: scopeKinds[input.scope] === "account" ? "account" : "node",
          },
          EVENT_NAMES.AGENT_ROLE_REQUESTED
        );
      return result;
    },
    async previewAsk({ token, resource }) {
      const ask = await withStore((store) => previewAsk(store, { token, resource }));
      return ask ? buildAskView(ask, declarations) : null;
    },
    async listMine(userId) {
      // PROFILE_NEVER_SHOWS_NODE_ROWS: only the account rows on the viewer's own account, and this node's AI x its account scopes.
      const { internal, rows } = await withStore(async (store) => {
        const accountId = await store.accountOf(userId);
        return {
          internal: await store.listInternalPrincipals(),
          rows: accountId ? await store.listAccountRoleRows(accountId, MAX_MINE_ROWS) : [],
        };
      });
      return {
        permissions: buildAccountAiView({ declarations, scopesByPrincipal: scopesOfCatalog(true), internal, rows, ask: null }),
        more: 0,
      };
    },
    async turnMineOn(me, input) {
      // The person's account is created on first decision, so the owner join in the decide statement always has an account to name.
      await deps.ensureBillingAccount?.(me.userId);
      if ("token" in input) {
        const { approved } = await withStore((store) => approveAccountAsk(store, { me, token: input.token, days: input.days }));
        if (approved)
          deps.log.info(
            { event: EVENT_NAMES.AGENT_ROLE_GRANTED, resource: "account", via: "link", approvedBy: me.userId },
            EVENT_NAMES.AGENT_ROLE_GRANTED
          );
        return { changed: approved };
      }
      const { principalUserId, created } = await withStore((store) =>
        grantInternalOnAccount(store, { me, principalUserId: input.principalUserId, scope: input.scope, declaredScopes, days: input.days })
      );
      if (created)
        deps.log.info(
          { event: EVENT_NAMES.AGENT_ROLE_GRANTED, principalUserId, scope: input.scope, resource: "account", via: "direct", approvedBy: me.userId },
          EVENT_NAMES.AGENT_ROLE_GRANTED
        );
      return { changed: created };
    },
    async turnMineOff(me, input) {
      if ("rowId" in input) {
        const { revoked } = await withStore((store) => revokeAccountRow(store, { me, rowId: input.rowId }));
        if (revoked)
          deps.log.info(
            { event: EVENT_NAMES.AGENT_ROLE_REVOKED, resource: "account", rowId: input.rowId, revokedBy: me.userId },
            EVENT_NAMES.AGENT_ROLE_REVOKED
          );
        return { changed: revoked };
      }
      const { denied } = await withStore((store) => denyAccountAsk(store, { me, token: input.token }));
      if (denied)
        deps.log.info(
          { event: EVENT_NAMES.AGENT_ROLE_DENIED, resource: "account", via: "link", deniedBy: me.userId },
          EVENT_NAMES.AGENT_ROLE_DENIED
        );
      return { changed: denied };
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
