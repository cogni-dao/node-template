// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/host`
 * Purpose: A node's wiring of this package, written once (task.0175): the store wrapper, the guard's decision log, the admin check over wallet bindings,
 *   and the role, ask and mine calls. A node passes its SQL client, its admin authority, its logger and its tool contracts, and gets one authority object.
 * Scope: Composition over this package's own functions, including (since task.0181) the org account, payer binding and service-ask methods. Takes a connection that bypasses row-level security: `agent_roles` and `agent_principals` are deny-all for the app
 *   role. Decides nothing itself (ONE_AUTHORIZE_FN lives in `./authorize`).
 * Invariants:
 *   - ADMIN_FROM_USER_BINDINGS: the human's wallet(s) come from `user_bindings` (provider = wallet), never from the request. Any bound admin wallet passes;
 *     no wallet is denied; no configured admins is unavailable.
 *   - DECLARED_SCOPES_FROM_CONTRACTS: the scopes a role may name are exactly those the node's tool contracts declare (`buildPermissionCatalog`).
 *   - NO_SECRETS_IN_LOGS: `agent_tool.authz` carries ids, tool, decision and code only.
 *   - OWNERS_READ_BEFORE_THE_TRANSACTION: a decision that opens a transaction (`withStore`, `sql.begin`) never reads an owner source inside it. The `org-statement` source takes a
 *     SECOND connection (wallet mapping, held version, refresh), so inside a transaction two concurrent requests could hold every connection of a small pool and wait on each other.
 *     The owners are read first (`snapshotOwners`) and the transaction answers from that snapshot.
 *   - EVENT_NAMES_HERE: `AGENT_HOST_EVENTS` owns the event names; a node's registry repeats them only as these values (a parity test pins it).
 *   - PORT_MEANS_INTERFACE: `NodeAdminCheckPort` and `HostLog` are interfaces the node implements; this file imports no logger, no node table and no ai-tools.
 * Side-effects: IO (database reads and writes through the injected client), log lines through the injected logger
 * Links: https://node-template.cognidao.org/knowledge/agent-run-authority
 * @public
 */

import { type MineListInput, listMine, scopesByPrincipalOf, turnMineOff, turnMineOn } from "./account-access";
import type { ApprovalCaller } from "./approval";
import {
  type AdminOrgRow,
  applyStatement,
  assertOrgChargeable,
  type BillTo,
  billToScopeUserFor as billToScopeUserForPure,
  claimHolds,
  hasOpenHolds,
  type ConnectResult,
  createPostgresBillToLookups,
  createPostgresReplayStore,
  disconnectOrg,
  grantOrgSpend,
  heldStatementMatches,
  heldStatementVersion,
  listMyOrgs as listMyOrgsRows,
  recordOrgFunded,
  resolveFundingAccount as resolveFundingAccountPure,
  listOrgAccountsForAdmin,
  logOrgEvent,
  type MyOrgRow,
  OrgAccountError,
  orgActor,
  type OrgAccountView,
  userWallets,
  type OrgAct,
  orgAccountView,
  orgByUserId,
  orgRoleOf,
  removeOrgSpend,
  resolveBillTo as resolveBillToPure,
  restoreOrg,
  suspendOrg,
} from "./org-accounts";
import { connectOrgOutbound, directoryEntry, disconnectOrgOutbound, listOrgConnections, type OrgDirectoryEntry, refreshOrgOutbound } from "./org-connect";
import { type OrgConnectionsAuthority, ORG_CONNECT_SERVICE } from "./org-http";
import {
  createOrgStatementIssuer,
  createOrgStatementOwnerSource,
  type OrgFacts,
  type OrgFetch,
  ORG_JWKS_PATH,
  verifyOrgStatement,
} from "./org-statement";
import { canonicalRepoRef, ensureOrg, isCanonicalOrgOrigin, type OrgOwners, type OrgSource, OwnerSourceUnavailableError } from "./orgs";
import {
  createPostgresPayerBindingStore,
  decidePayerBinding,
  ownersForBinding,
  payerFor,
  requestPayerBinding,
  revokePayerBinding,
} from "./payer";
import {
  createServiceAssertionVerifier,
  findServicePrincipal,
  requestServiceAccess,
  type ServiceAssertionResult,
  type ServiceAssertionSigner,
  type VerifiedServiceAssertion,
} from "./service-auth";
import { addOnly, type Contribution } from "./add-only";
import { type AgentRoutes, authorizeCaller, composeAgentRoutes, type ComposedRoutes } from "./same-door";
import { buildAskView, buildNodeAiView } from "./node-ai";
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
  payerBound: "payer.bound",
  payerRevoked: "payer.revoked",
  payerSelected: "payer.selected",
  orgEnsured: "org.ensured",
  /** One line per act on an org account (the history table is the record; this is the log of it). Fields: act, orgUserId, actor. */
  orgAct: "org.act",
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

/** Two declarations of one scope are the same when every field matches. */
function sameDeclaration(a: ToolRequires, b: ToolRequires): boolean {
  return a.scope === b.scope && a.kind === b.kind && a.subject === b.subject && a.label === b.label && a.description === b.description;
}

/**
 * The one derivation of a node's permission catalog from its declarations. The role routes (`declaredScopes`), the ask door (`askableScopes`) and agent
 * discovery (`permissions`) all read it. DECLARED_ONCE_SHOWN_EVERYWHERE: a scope with no label and description is not shown. ASKABLE_IS_REACHABLE: an
 * outside agent can ask only for a scope a route twin uses. `routes` (@beta) is a node's add-only route twins and route-only capabilities (`composeAgentRoutes`).
 * SCOPE_DECLARED_ONCE: a scope declared again with a different kind, subject, label or description throws; a repeat that matches field for field is the same declaration.
 */
export function buildPermissionCatalog(requiresById: Readonly<Record<string, ToolRequires>>, routes?: AgentRoutes): PermissionCatalog {
  return catalogOf(requiresById, composeAgentRoutes(routes));
}

function catalogOf(requiresById: Readonly<Record<string, ToolRequires>>, composed: ComposedRoutes): PermissionCatalog {
  // SCOPE_DECLARED_ONCE: one declaration per scope. A repeat that matches field for field (two tools sharing a scope) is the same declaration.
  const bySource = (source: string, r: ToolRequires): Contribution<ToolRequires> => ({ source, entries: { [r.scope]: r } });
  const requires = addOnly<ToolRequires>(
    { what: "scope", code: "SCOPE_DECLARED_TWICE", same: sameDeclaration },
    ...Object.entries(requiresById).map(([id, r]) => bySource(id, r)),
    ...Object.entries(composed.routeOnlyCapabilities).map(([id, cap]) => bySource(id, cap.requires))
  );

  const declarations: Record<string, PermissionDeclaration> = {};
  const scopeKinds: Record<string, ScopeKind> = {};
  for (const r of Object.values(requires)) {
    declarations[r.scope] = { label: r.label, description: r.description };
    scopeKinds[r.scope] = r.kind;
  }
  const declaredScopes = Object.keys(declarations).sort();
  const askableScopes = [
    ...new Set([
      ...Object.values(composed.sameDoorRoutes).map((r) => r.scope),
      ...Object.values(composed.routeOnlyCapabilities).map((c) => c.requires.scope),
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

/**
 * What the in-process graph provider reads of a node's authority (`AgentAuthorityPort`, the provider's own structural type; task.0175 provider move).
 * `AgentToolAuthority` extends it, so a change that breaks the provider's shape fails `tsc` here, and the provider package never imports this one.
 */
export interface AgentAuthorityPort {
  /** The seeded user id for a catalog principal slug, or null when no row exists (the run is then denied). */
  resolvePrincipal(slug: string): Promise<string | null>;
  /** Guard dependencies. `runAs` is supplied by the provider, which owns the run scope. */
  readonly guardDeps: Omit<GuardDeps, "runAs">;
}

export interface AgentToolAuthority extends AgentAuthorityPort {
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
  /** The scopes an outside agent may ask for. */
  readonly askableScopes: readonly string[];

  // ---- payer bindings (story.0038 phase 2) ----
  /** PAYER_IS_AUTHORIZED: a subject (any principal) asks to be billed to `billingAccountId`. Grants nothing. Throws AgentRolesError (`not_allowed` when a live binding must be turned Off first, `too_many_requests`). */
  requestPayerBinding(subjectUserId: string, billingAccountId: string): Promise<{ id: string; state: "pending" | "live"; created: boolean }>;
  /** An owner of the account (an org's owners through its owner source) turns a pending binding On (`approve`) or dismisses it. */
  decidePayerBinding(me: ApprovalCaller, id: string, approve: boolean): Promise<{ changed: boolean }>;
  /** An owner of the account turns a binding Off. The subject's next run falls back to its own account. */
  revokePayerBinding(me: ApprovalCaller, id: string): Promise<{ changed: boolean }>;
  /** The account a live binding names for this subject, or null. Read on every call, never cached. */
  payerFor(subjectUserId: string): Promise<string | null>;
  /** The org for a source, created if absent: its own users row and one ordinary billing account. */
  ensureOrg(source: OrgSource): Promise<{ userId: string; billingAccountId: string }>;
  /** The principal user id a verified service assertion maps to, or null when it never asked. */
  servicePrincipalOf(assertion: Pick<VerifiedServiceAssertion, "issuer" | "service">): Promise<string | null>;
  /** A verified service asks for a scope for itself: one pending ask on its own principal. */
  requestServiceAccess(assertion: VerifiedServiceAssertion, scope: string): Promise<AskOutcome>;

  // ---- org accounts (task.0181) ----
  /** "Your orgs": the org accounts the person holds a role on. Claims spend grants held for the person's wallets first. */
  listMyOrgs(userId: string, after?: string | null): Promise<{ orgs: MyOrgRow[]; next: string | null }>;
  /** One org account page, or null when the person holds no role on it. */
  orgView(userId: string, orgUserId: string, page?: { historyBefore?: string | null; peopleAfter?: string | null }): Promise<OrgAccountView | null>;
  /** An admin of the org (by its statement) gives a wallet `org:spend`. Throws OrgAccountError `not_allowed` or `not_found` (the route answers both with one 404) and `invalid_wallet`; OwnerSourceUnavailableError (503) when the statement is unreadable. */
  grantSpend(me: { userId: string }, orgUserId: string, wallet: string): Promise<{ changed: boolean; held: boolean }>;
  removeSpend(me: { userId: string }, orgUserId: string, wallet: string): Promise<{ changed: boolean }>;
  /** The org's connect: pull and verify the statement at `origin` (never from the cache), create or refresh the account. */
  connectOrg(origin: string): Promise<ConnectResult>;
  disconnectOrg(origin: string): Promise<ConnectResult | null>;
  /** `/admin`: every org account on this node. */
  adminOrgs(after?: string | null): Promise<{ orgs: AdminOrgRow[]; next: string | null }>;
  /** Throws OrgAccountError `org_suspended` when this billing account is a suspended org's. Called at every charge point (a suspension stops the NEXT call; no reliance on row-level security). */
  assertChargeable(billingAccountId: string): Promise<void>;
  /** This node's admin (the node checked the session) suspends or restores an org account, with a reason. */
  setSuspension(input: { by: string; orgUserId: string; suspend: boolean; reason: string }): Promise<{ status: "connected" | "disconnected" | "suspended" }>;
  /** Verify the bearer of an org's connect or disconnect call (an origin of the fleet directory; service `org-connect`). */
  verifyOrgCall(token: string): Promise<ServiceAssertionResult>;
  /** This node as an org: the nodes it connected to, and connect and disconnect. */
  readonly orgConnections: OrgConnectionsAuthority;
  /** This node as an org: a freshly signed statement JWT for `/.well-known/cogni-org`, or null while no signer or org identity is configured. */
  orgStatement(): Promise<string | null>;
  /** ONE_RESOLVER: the paying account for a run. Throws OrgAccountError `not_allowed` or `org_suspended`. */
  resolveBillTo<A extends { readonly id: string; readonly ownerUserId?: string | undefined }>(input: {
    subjectUserId: string;
    own: A;
    chosenAccountId?: string | undefined;
    getAccount: (billingAccountId: string) => Promise<A | null>;
  }): Promise<BillTo<A>>;
  /**
   * FUND: the account a person may fund and the user whose scope credits it. No account = their own; an org account only for an org ADMIN by the org's current statement (`org:spend` refuses).
   * Throws OrgAccountError `not_allowed` (also for an unknown account), `org_suspended` (with its reason) or `statement_unavailable` (503). Opens no transaction: owners are read first.
   */
  resolveFundingAccount(input: { userId: string; billingAccountId?: string | undefined }): Promise<{ billingAccountId: string; chargeScopeUserId: string }>;
  /**
   * Append `org.funded` to an org's history in its own transaction, EXACTLY ONCE per (org, `paymentRef`): a repeated payment id answers `{ recorded: false }` and logs nothing; a written one logs
   * an `org.act` line. Refuses a non-org account or an unknown actor (`not_allowed`), a non-positive amount (`invalid_amount`) and a `paymentRef` that is empty, over 200 characters or not
   * ASCII-printable (`invalid_payment_ref`, never truncated).
   */
  logOrgFunded(input: { orgBillingAccountId: string; actorUserId: string; amountCredits: number; paymentRef: string }): Promise<{ recorded: boolean }>;
  /** The user whose row-level-security scope reads and charges `billingAccountId` for a run the actor executes (an org's user only for an entitled actor; throws `org_suspended`). */
  billToScopeUserFor(input: {
    actorUserId: string;
    billingAccountId: string;
    getAccount: (billingAccountId: string) => Promise<{ readonly id: string; readonly ownerUserId?: string | undefined } | null>;
  }): Promise<string>;
}

export interface AgentToolAuthorityDeps {
  readonly sql: AgentAuthoritySql;
  readonly nodeAdmin: NodeAdminCheckPort;
  readonly log: HostLog;
  /** The node's tool contracts as `{ id, requires }` records. */
  readonly tools: readonly RequiresRecord[];
  /** A node's add-only route twins and route-only capabilities (`AgentRoutes`). A collision with the package baseline throws at construction. */
  readonly routes?: AgentRoutes | undefined;
  /** The node's graph catalog entries (`principal`, `toolIds`), for the table of which AI may use which scope. */
  readonly graphs: Iterable<{ readonly principal?: string | undefined; readonly toolIds: readonly string[] }>;
  /** The system principal ids `principalClass` calls `system`. */
  readonly systemUserIds: readonly string[];
  /** Create the person's billing account when they turn an account row On and have none yet. */
  readonly ensureBillingAccount?: ((userId: string) => Promise<string>) | undefined;
  /**
   * The node's owner sources for repo-spec orgs (story.0038); absent means no repo-spec org has owners. The `org-statement` source is built here from the node's own database,
   * so an org account's admins are read from its statement whatever this is.
   */
  readonly owners?: OrgOwners | undefined;
  /** This node's id: the audience of an org's signed connect (`urn:cogni:node:<id>`) and the `sub` of the statement this node signs as an org. Without it no connect is accepted. */
  readonly nodeId?: string | undefined;
  /** This node's signer (read lazily), for the statement it serves as an org and the connect it sends. Null = this node is not an org. */
  readonly signer?: (() => Promise<ServiceAssertionSigner | null>) | undefined;
  /** This node as an org: its canonical https origin and the repo-spec facts its statement carries (read on every signing). Absent = no statement is served. */
  readonly orgIdentity?:
    | {
        readonly origin: string;
        readonly facts: () => Promise<OrgFacts> | OrgFacts;
        /** The statement `version`: the running build's commit time in epoch seconds (see `createOrgStatementIssuer`). Absent = this node signs NO statement and connects to no node (`org.statement.unversioned`). */
        readonly version?: number | undefined;
      }
    | undefined;
  /**
   * The FLEET DIRECTORY (the node's `.cogni/service-links.yaml` targets today): the only origins an org may connect from or this node may connect to, each with its node id. An origin
   * outside it is `not_in_directory`; the node id in a statement must equal the directory's (`wrong_node`). Absent or empty = no org connects.
   */
  readonly directory?: readonly OrgDirectoryEntry[] | undefined;
  /** Fetch for the org statement and JWKS reads (default: https, bounded, no redirect). Tests inject. */
  readonly orgFetch?: OrgFetch | undefined;
  /** Fetch for this node's outbound connect (default `fetch`). Tests inject. */
  readonly fetch?: typeof fetch | undefined;
  /** The node's failure-class fields for an unavailable-store log (name, SQLSTATE, never a message). */
  readonly failureFields?: ((error: unknown) => object) | undefined;
}

export function createAgentToolAuthority(deps: AgentToolAuthorityDeps): AgentToolAuthority {
  const requiresById = buildRequiresById(deps.tools);
  const routes = composeAgentRoutes(deps.routes);
  const { declarations, scopeKinds, declaredScopes, askableScopes, permissions } = catalogOf(requiresById, routes);
  const graphs = [...deps.graphs];
  const scopesOf = (plane: "account" | "node") => scopesByPrincipalOf(graphs, requiresById, plane);
  const adminCheck = createAdminCheck(deps.sql, deps.nodeAdmin);
  const failure = deps.failureFields ?? (() => ({}));

  // ORG ACCOUNTS (task.0181): the `org-statement` owner source is built here over this node's own tables, and joined to the node's repo-spec source into the one owner reader
  // every decision uses. A newly verified statement refreshes the account row and logs admin and service changes (a stale one changes nothing).
  const directory = deps.directory ?? [];
  const orgSource = createOrgStatementOwnerSource({
    usersForWallets: async (wallets) =>
      (
        await deps.sql`SELECT DISTINCT user_id FROM user_bindings WHERE provider = 'wallet' AND external_id = ANY(${wallets}) LIMIT 200`
      ).map((row) => String(row.user_id)),
    heldVersion: (origin) => heldStatementVersion(deps.sql, origin),
    holdsFacts: (statement) => heldStatementMatches(deps.sql, statement),
    onVerified: async (statement) => {
      // A refresh re-checks the directory and the node id: a statement from an origin outside it, or naming another node, is never recorded (and so never served).
      const entry = directoryEntry(directory, statement.origin);
      if (!entry) throw new OrgAccountError("not_in_directory", "origin is not in the fleet directory");
      if (entry.nodeId !== statement.nodeId) throw new OrgAccountError("wrong_node", "the statement's node id does not match the directory");
      const applied = await deps.sql.begin((tx) => applyStatement(tx, statement, "refresh"));
      // An older statement than the one held changed nothing: it is neither served nor cached (it could carry an admin the newer one removed).
      if (applied && !applied.applied) throw new OwnerSourceUnavailableError("stale");
      if (applied) logChangedLists(applied, statement.origin);
    },
    onRefreshError: (error) =>
      deps.log.error({ event: AGENT_HOST_EVENTS.rolesUnavailable, routeId: "org.statement.refresh", ...failure(error) }, AGENT_HOST_EVENTS.rolesUnavailable),
    ...(deps.orgFetch ? { fetch: deps.orgFetch } : {}),
  });
  const owners: OrgOwners = {
    owners: (source) =>
      source.kind === "org-statement"
        ? orgSource.owners(source)
        : deps.owners
          ? deps.owners.owners(source)
          : Promise.reject(new OwnerSourceUnavailableError("no owner source for this kind")),
  };
  const statementServices = async (origin: string): Promise<readonly string[]> => (await orgSource.statement(origin)).services;
  /**
   * OWNERS_READ_BEFORE_THE_TRANSACTION: read the owners of the orgs behind these accounts NOW (outside any transaction) and answer from that snapshot inside it. An account that is no
   * org's needs no read; an unreadable owner source is kept as the failure and thrown when the decision asks (fail closed, never an allow).
   */
  const snapshotOwners = async (accountIds: ReadonlyArray<string | undefined>): Promise<OrgOwners> => {
    const grants = createPostgresAgentGrantsStore(deps.sql);
    const keyOf = (source: OrgSource) => `${source.kind}\u0000${source.ref}\u0000${"path" in source ? (source.path ?? "") : ""}`;
    const known = new Map<string, readonly string[] | OwnerSourceUnavailableError>();
    for (const accountId of new Set(accountIds.filter((id): id is string => typeof id === "string" && id.length > 0))) {
      const source = await grants.orgSourceOfAccount?.(accountId);
      if (!source) continue;
      try {
        known.set(keyOf(source), await owners.owners(source));
      } catch (error) {
        if (!(error instanceof OwnerSourceUnavailableError)) throw error;
        known.set(keyOf(source), error);
      }
    }
    return {
      owners: async (asked) => {
        const hit = known.get(keyOf(asked));
        if (hit instanceof Error) throw hit;
        return hit ?? [];
      },
    };
  };
  const logOrgAct = (act: OrgAct, orgUserId: string, actor: string): void =>
    deps.log.info({ event: AGENT_HOST_EVENTS.orgAct, act, orgUserId, actor }, AGENT_HOST_EVENTS.orgAct);
  /** A statement (a connect, or a refresh the owner source read) that changed the admins or the services: one line each, like every other act (the history row was written in the same transaction). */
  const logChangedLists = (result: ConnectResult, origin: string): void => {
    if (result.changed?.admins) logOrgAct("org.admins_changed", result.orgUserId, `org:${origin}`);
    if (result.changed?.services) logOrgAct("org.services_changed", result.orgUserId, `org:${origin}`);
  };
  const connectVerifier = deps.nodeId
    ? createServiceAssertionVerifier({
        selfNodeId: deps.nodeId,
        trustedHomes: [],
        // ONLY an origin the fleet directory lists may connect, as the one service `org-connect`. Everything else is `untrusted_issuer` before any key is fetched.
        homeFor: (issuer) => {
          const entry = directoryEntry(directory, issuer);
          return entry ? { issuer: entry.origin, jwksUri: new URL(ORG_JWKS_PATH, entry.origin).href, services: [ORG_CONNECT_SERVICE] } : undefined;
        },
        // The replay store is the database, so every replica shares it.
        replay: createPostgresReplayStore(deps.sql),
      })
    : null;
  /** The org statement this node last signed (see `orgStatement`). */
  let signed: { key: string; jwt: string; until: number } | null = null;
  let lastUnversionedLog = 0;
  /** Nodes asked to refresh after a change of facts or a new build: at most this many per run, this many at a time. */
  const REPOST_MAX = 50;
  const REPOST_PARALLEL = 5;
  let reposting = false;
  let changedDuringRun = false;
  const repostPass = async (mode: "changed" | "boot"): Promise<void> => {
    const identity = deps.orgIdentity;
    if (!identity) return;
    // A boot pass asks the nodes (including unreachable ones) whose acknowledged version is below this build's; a change pass asks the connected ones.
    const filter = mode === "boot" && identity.version !== undefined ? { statuses: ["connected", "unreachable"] as const, below: identity.version, connectsOnly: true } : { statuses: ["connected"] as const };
    // Every line of a pass names the actor (this org's own service principal) once it is known.
    let actor: string | undefined;
    try {
      const by = await orgActor(deps.sql, identity.origin);
      actor = by;
      const outbound = { sql: deps.sql, directory, signer: async () => (await deps.signer?.()) ?? null, fetch: deps.fetch, version: identity.version };
      let after: string | null = null;
      let told = 0;
      do {
        // Only the nodes the filter names are read (it is in the query), a page at a time by origin.
        const page: Awaited<ReturnType<typeof listOrgConnections>> = await listOrgConnections(deps.sql, after, filter);
        const room = REPOST_MAX - told;
        const targets = page.connections.slice(0, room);
        for (let i = 0; i < targets.length; i += REPOST_PARALLEL) {
          await Promise.all(
            targets.slice(i, i + REPOST_PARALLEL).map(async (target) => {
              try {
                const result = await refreshOrgOutbound(outbound, target.origin, by);
                deps.log.info({ event: AGENT_HOST_EVENTS.orgAct, act: "org.connection.refresh", actor: by, origin: target.origin, status: result.status }, AGENT_HOST_EVENTS.orgAct);
              } catch (error) {
                deps.log.warn({ event: AGENT_HOST_EVENTS.orgAct, act: "org.connection.refresh_failed", actor: by, origin: target.origin, ...failure(error) }, AGENT_HOST_EVENTS.orgAct);
              }
            })
          );
        }
        told += targets.length;
        after = page.next;
        // The cap is never silent: nodes beyond it learn the change at their next statement read (within the cache window).
        if (told >= REPOST_MAX && (after !== null || targets.length < page.connections.length)) {
          deps.log.warn({ event: AGENT_HOST_EVENTS.orgAct, act: "org.connection.refresh_capped", actor: by, mode, cap: REPOST_MAX }, AGENT_HOST_EVENTS.orgAct);
          break;
        }
      } while (after !== null);
      deps.log.info({ event: AGENT_HOST_EVENTS.orgAct, act: "org.connection.refresh_pass", actor: by, mode, told }, AGENT_HOST_EVENTS.orgAct);
    } catch (error) {
      deps.log.warn({ event: AGENT_HOST_EVENTS.orgAct, act: "org.connection.refresh_failed", ...(actor ? { actor } : {}), ...failure(error) }, AGENT_HOST_EVENTS.orgAct);
    }
  };
  /** One run at a time; a change of facts DURING a run earns exactly one more run after it, so the last change is always told. */
  const repostConnect = async (mode: "changed" | "boot" = "changed"): Promise<void> => {
    if (reposting) {
      changedDuringRun = true;
      return;
    }
    reposting = true;
    try {
      for (let run = 0; run < 2; run += 1) {
        changedDuringRun = false;
        await repostPass(run === 0 ? mode : "changed");
        if (!changedDuringRun) break;
      }
    } finally {
      reposting = false;
      changedDuringRun = false;
    }
  };
  const requireAdmin = async (userId: string, orgUserId: string) => {
    const org = await orgByUserId(deps.sql, orgUserId);
    if (!org) throw new OrgAccountError("not_found", "no such org account");
    // The statement is read BEFORE the write transaction opens, so no connection waits on the org's node.
    const { role, adminLapsed } = await orgRoleOf(deps.sql, owners, { userId, org });
    if (role !== "admin") {
      if (adminLapsed) throw new OwnerSourceUnavailableError("statement unreadable");
      throw new OrgAccountError("not_allowed", "only an org admin may do this");
    }
    return org;
  };
  const billToLookups = createPostgresBillToLookups(deps.sql, owners, statementServices);

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
    askableScopes,
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
      const requires = requiresById[toolId] ?? routes.routeOnlyCapabilities[toolId]?.requires;
      const decision: AuthzDecision = !requires
        ? { decision: "deny", code: "policy_denied", reason: "no_requires" }
        : await snapshotOwners([accountId])
            .then((snapshot) => withStore((store) => authorizeCaller(store, adminCheck, { userId, via, requires, accountId, owners: snapshot })))
            .catch((): AuthzDecision => ({ decision: "deny", code: "authz_unavailable", reason: "store_unavailable" }));
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
      const snapshot = await snapshotOwners(["token" in input ? input.accountId : undefined]);
      const result = await withStore((store) =>
        turnMineOn(store, { me, on: input, declaredScopes, scopeKinds, ensureAccount: deps.ensureBillingAccount, owners: snapshot })
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
      const rowAccount = "rowId" in input ? (await createPostgresAgentGrantsStore(deps.sql).accountRoleOf?.(input.rowId))?.accountId : input.accountId;
      const snapshot = await snapshotOwners([rowAccount]);
      const result = await withStore((store) => turnMineOff(store, { me, off: input, owners: snapshot }));
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

    async requestPayerBinding(subjectUserId, billingAccountId) {
      const outcome = await deps.sql.begin((tx) =>
        requestPayerBinding(createPostgresPayerBindingStore(tx), { subjectUserId, billingAccountId })
      );
      return { id: outcome.id, state: outcome.state, created: outcome.created };
    },
    async decidePayerBinding(me, id, approve) {
      // OWNERS_READ_BEFORE_THE_TRANSACTION: an org's owners (a network read) are read before `begin`, so no database connection waits on it.
      const bindingOwners = await ownersForBinding(createPostgresPayerBindingStore(deps.sql), createPostgresAgentGrantsStore(deps.sql), owners, id);
      const result = await deps.sql.begin((tx) =>
        decidePayerBinding(createPostgresPayerBindingStore(tx), createPostgresAgentGrantsStore(tx), { me, id, approve, owners: bindingOwners })
      );
      if (result.decided) {
        const event = approve ? AGENT_HOST_EVENTS.payerBound : AGENT_HOST_EVENTS.payerRevoked;
        deps.log.info(
          { event, subject: result.subjectUserId, billingAccountId: result.billingAccountId, ...(approve ? { approvedBy: me.userId } : { revokedBy: me.userId }) },
          event
        );
      }
      return { changed: result.decided };
    },
    async revokePayerBinding(me, id) {
      // The subject turning its own binding Off needs no owner read (an unreadable org statement must not lock it out); anyone else's Off reads the owners first.
      const held = await createPostgresPayerBindingStore(deps.sql).get(id);
      const bindingOwners =
        held && held.subjectUserId === me.userId
          ? undefined
          : await ownersForBinding(createPostgresPayerBindingStore(deps.sql), createPostgresAgentGrantsStore(deps.sql), owners, id);
      const result = await deps.sql.begin((tx) =>
        revokePayerBinding(createPostgresPayerBindingStore(tx), createPostgresAgentGrantsStore(tx), { me, id, owners: bindingOwners })
      );
      if (result.revoked)
        deps.log.info(
          { event: AGENT_HOST_EVENTS.payerRevoked, subject: result.subjectUserId, billingAccountId: result.billingAccountId, revokedBy: me.userId },
          AGENT_HOST_EVENTS.payerRevoked
        );
      return { changed: result.revoked };
    },
    payerFor: (subjectUserId) => payerFor(createPostgresPayerBindingStore(deps.sql), subjectUserId),
    async ensureOrg(source) {
      const org = await deps.sql.begin((tx) => ensureOrg(tx, source));
      deps.log.info(
        {
          event: AGENT_HOST_EVENTS.orgEnsured,
          orgUserId: org.userId,
          sourceRef: source.kind === "repo-spec" ? (canonicalRepoRef(source.ref, source.path) ?? source.ref) : source.ref,
        },
        AGENT_HOST_EVENTS.orgEnsured
      );
      return org;
    },
    servicePrincipalOf: (assertion) => findServicePrincipal(deps.sql, assertion),
    async requestServiceAccess(assertion, scope) {
      const { userId, outcome } = await deps.sql.begin((tx) =>
        requestServiceAccess({
          tx,
          store: createPostgresAgentGrantsStore(tx),
          assertion,
          scope,
          declaredScopes,
          askableScopes,
          scopeKinds,
        })
      );
      if (outcome.created)
        deps.log.info(
          { event: AGENT_HOST_EVENTS.roleRequested, principalUserId: userId, scope, resource: scopeKinds[scope] === "account" ? "account" : "node" },
          AGENT_HOST_EVENTS.roleRequested
        );
      return outcome;
    },

    async listMyOrgs(userId, after) {
      // The wallets are read once. A transaction opens only when a hold is waiting for one of them (every page of the account menu calls this).
      const wallets = await userWallets(deps.sql, userId);
      if (await hasOpenHolds(deps.sql, wallets)) {
        const claimed = await deps.sql.begin((tx) => claimHolds(tx, userId, wallets));
        if (claimed > 0) deps.log.info({ event: AGENT_HOST_EVENTS.orgAct, act: "org.spend_claimed", actor: userId, count: claimed }, AGENT_HOST_EVENTS.orgAct);
      }
      return listMyOrgsRows(deps.sql, async (origin) => (await orgSource.statement(origin)).admins, userId, wallets, after ?? null);
    },
    orgView: (userId, orgUserId, page) =>
      orgAccountView(deps.sql, { owners, statementServices, userId, orgUserId, historyBefore: page?.historyBefore ?? null, peopleAfter: page?.peopleAfter ?? null }),
    async grantSpend(me, orgUserId, wallet) {
      const org = await requireAdmin(me.userId, orgUserId);
      const result = await deps.sql.begin((tx) => grantOrgSpend(tx, { org, by: me.userId, wallet }));
      if (result.changed) logOrgAct("org.spend_granted", orgUserId, me.userId);
      return result;
    },
    async removeSpend(me, orgUserId, wallet) {
      const org = await requireAdmin(me.userId, orgUserId);
      const result = await deps.sql.begin((tx) => removeOrgSpend(tx, { org, by: me.userId, wallet }));
      if (result.changed) logOrgAct("org.spend_removed", orgUserId, me.userId);
      return result;
    },
    async connectOrg(origin) {
      // A connect always pulls a FRESH statement (never the cache), then the version floor and the history are in the one transaction.
      const entry = directoryEntry(directory, origin);
      if (!entry) throw new OrgAccountError("not_in_directory", "origin is not in the fleet directory");
      const verified = await verifyOrgStatement({ origin: entry.origin, ...(deps.orgFetch ? { fetch: deps.orgFetch } : {}) });
      if (!verified.ok) throw new OwnerSourceUnavailableError(verified.code);
      if (verified.statement.nodeId !== entry.nodeId) throw new OrgAccountError("wrong_node", "the statement's node id does not match the directory");
      const result = await deps.sql.begin((tx) => applyStatement(tx, verified.statement, "connect"));
      if (!result) throw new OrgAccountError("not_found", "no such org account");
      // Only an applied statement is an act: an older one changed nothing.
      if (result.applied) {
        logOrgAct("org.connected", result.orgUserId, `org:${entry.origin}`);
        logChangedLists(result, entry.origin);
      }
      return result;
    },
    async disconnectOrg(origin) {
      // The directory's own spelling of the origin is the key (a trailing slash or case in a token never names another org).
      const entry = directoryEntry(directory, origin);
      if (!entry) throw new OrgAccountError("not_in_directory", "origin is not in the fleet directory");
      const result = await deps.sql.begin((tx) => disconnectOrg(tx, entry.origin));
      if (result) logOrgAct("org.disconnected", result.orgUserId, `org:${entry.origin}`);
      return result;
    },
    adminOrgs: (after) => listOrgAccountsForAdmin(deps.sql, { after: after ?? null }),
    assertChargeable: (billingAccountId) => assertOrgChargeable(deps.sql, billingAccountId),
    async setSuspension({ by, orgUserId, suspend, reason }) {
      await deps.sql.begin((tx) => (suspend ? suspendOrg(tx, { orgUserId, by, reason }) : restoreOrg(tx, { orgUserId, by, reason })));
      logOrgAct(suspend ? "org.suspended" : "org.restored", orgUserId, by);
      const org = await orgByUserId(deps.sql, orgUserId);
      return { status: org?.status ?? "connected" };
    },
    verifyOrgCall: async (token) => (connectVerifier ? connectVerifier.verify(token) : { ok: false, code: "untrusted_issuer" }),
    orgConnections: {
      list: (after) => listOrgConnections(deps.sql, after ?? null),
      connect: async (origin, by) => {
        const result = await connectOrgOutbound({ sql: deps.sql, directory, signer: async () => (await deps.signer?.()) ?? null, fetch: deps.fetch, version: deps.orgIdentity?.version }, origin, by);
        deps.log.info({ event: AGENT_HOST_EVENTS.orgAct, act: "org.connection.connect", origin: result.origin, status: result.status, actor: by }, AGENT_HOST_EVENTS.orgAct);
        return result;
      },
      disconnect: async (origin, by) => {
        const result = await disconnectOrgOutbound({ sql: deps.sql, directory, signer: async () => (await deps.signer?.()) ?? null, fetch: deps.fetch }, origin, by);
        deps.log.info({ event: AGENT_HOST_EVENTS.orgAct, act: "org.connection.disconnect", origin: result.origin, status: result.status, actor: by }, AGENT_HOST_EVENTS.orgAct);
        return result;
      },
    },
    async orgStatement() {
      const signer = await deps.signer?.();
      if (!signer || !deps.orgIdentity || !deps.nodeId) return null;
      // NO_BUILD_TIME_NO_STATEMENT: the statement's version is the build's commit time; without one this node signs nothing (never its issue time) and the route answers 404.
      if (deps.orgIdentity.version === undefined) {
        const at = Date.now();
        if (at - lastUnversionedLog > 60_000) {
          lastUnversionedLog = at;
          deps.log.warn({ event: AGENT_HOST_EVENTS.orgAct, act: "org.statement.unversioned" }, AGENT_HOST_EVENTS.orgAct);
        }
        return null;
      }
      // THROTTLED: the signed statement is reused for its lifetime minus a margin while the facts it carries are unchanged, so a hit does not sign. A change in the facts (an approver
      // removed from the repo-spec) signs a new one at once, so the removal still reaches the nodes within their own five-minute cache.
      const facts = await deps.orgIdentity.facts();
      const key = JSON.stringify([facts.dao, [...facts.admins].sort(), [...facts.services].sort(), facts.commit]);
      const at = Date.now();
      if (signed && signed.key === key && at < signed.until) return signed.jwt;
      const jwt = await createOrgStatementIssuer({ signer, origin: deps.orgIdentity.origin, nodeId: deps.nodeId, facts: () => facts, version: deps.orgIdentity.version }).statement();
      const firstSigning = signed === null;
      const factsChanged = signed !== null && signed.key !== key;
      signed = { key, jwt, until: at + STATEMENT_REUSE_MS };
      // A changed fact (an approver added or removed) asks the nodes this org is CONNECTED to (at most 50 per run, best effort) to pull the statement now. The first signing after boot (a new build, so
      // possibly new approvers) does one bounded pass to the connected and unreachable nodes still below this build's version. Fire and forget, logged; a node left out reads it within its cache window.
      if (factsChanged) void repostConnect();
      else if (firstSigning) void repostConnect("boot");
      return jwt;
    },
    async resolveBillTo({ subjectUserId, own, chosenAccountId, getAccount }) {
      const payer = createPostgresPayerBindingStore(deps.sql);
      const result = await resolveBillToPure(
        { ...billToLookups, payerFor: (id) => payerFor(payer, id), getAccount },
        { subjectUserId, own, chosenAccountId }
      );
      if (result.source !== "own")
        deps.log.info(
          { event: AGENT_HOST_EVENTS.payerSelected, subject: subjectUserId, billingAccountId: result.account.id, source: result.source },
          AGENT_HOST_EVENTS.payerSelected
        );
      return result;
    },
    resolveFundingAccount: (input) =>
      resolveFundingAccountPure(
        {
          ownAccountId:
            deps.ensureBillingAccount ??
            (async (userId) => {
              const rows = await deps.sql`SELECT id FROM billing_accounts WHERE owner_user_id = ${userId} ORDER BY created_at LIMIT 1`;
              if (!rows[0]) throw new OrgAccountError("not_allowed", "no billing account");
              return String(rows[0].id);
            }),
          accountOwner: async (id) => {
            const rows = await deps.sql`SELECT owner_user_id FROM billing_accounts WHERE id = ${id} LIMIT 1`;
            return rows[0] ? String(rows[0].owner_user_id) : null;
          },
          orgOfAccount: billToLookups.orgOfAccount,
          roleOf: billToLookups.roleOf,
        },
        input
      ),
    async logOrgFunded(input) {
      const { recorded, orgUserId } = await deps.sql.begin((tx) => recordOrgFunded(tx, input));
      // Only a row that was written is an act: a repeated payment id changed nothing.
      if (recorded) deps.log.info({ event: AGENT_HOST_EVENTS.orgAct, act: "org.funded", orgUserId, actor: input.actorUserId, amountCredits: input.amountCredits }, AGENT_HOST_EVENTS.orgAct);
      return { recorded };
    },
    billToScopeUserFor: ({ actorUserId, billingAccountId, getAccount }) =>
      billToScopeUserForPure(
        { ...billToLookups, payerFor: (id) => payerFor(createPostgresPayerBindingStore(deps.sql), id), getAccount },
        { actorUserId, billingAccountId }
      ),
  };
}

/** A signed org statement lives 300 s; it is reused for 240 s (its lifetime minus a 60 s margin). */
const STATEMENT_REUSE_MS = 240_000;

/** postgres.js codes for a connection that ended under a query; the transaction did not commit. */
const CONNECTION_LOSS_CODES = new Set(["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"]);
function isConnectionLoss(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    CONNECTION_LOSS_CODES.has(String((error as { code?: unknown }).code))
  );
}
