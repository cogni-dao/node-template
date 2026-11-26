// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/schema`
 * Purpose: The Drizzle definitions of `agent_principals`, `agent_roles` and `agent_credentials`, so a node never copies them (task.0175).
 * Scope: Schema only. `defineAgentAuthoritySchema` takes the node's own `users` and `billingAccounts` tables as foreign-key targets, so the package never names them.
 *   The node calls it once, re-exports the result from its own schema package and runs its own `db:generate`. The SQL tails drizzle cannot emit
 *   (FORCE row-level security, functions, triggers) live in `migrations/`. `payer_bindings`, `org_accounts`, `org_events`, `org_wallet_holds`, `org_connections`, `org_service_principals` and `org_connect_jtis` come from the same factory (task.0181).
 * Invariants:
 *   - REFS_INJECTED: the factory imports no node table. `drizzle-orm` is a peer dependency, so the node's drizzle-kit and the factory share one instance.
 *   - An internal principal row points at a seeded `users` row that has no credential.
 *   - CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: `agent_credentials` rows belong only to a user with an `external` `agent_principals` row (a trigger in `migrations/agent_credentials.sql` enforces it).
 *   - ROLE_ROWS_ARE_SOFT_REVOKED: a role row is never deleted; `revoked_at` ends it. One live row per (principal, scope).
 *   - ONE_GRANT_ROW (task.5465): node and account grants are one table, `agent_roles`; `resource` and `account_id` say which.
 *   - TOKEN_HASH_ONLY / STATE_IS_DERIVED: `agent_credentials` stores sha256 of the key and timestamps only; state is derived by the SQL function `agent_credential_state`, never stored.
 *   - SERVICE_ROLE_ONLY_WRITES: `agent_credentials` has ENABLE + FORCE RLS and no policy. `agent_roles` has ENABLE + FORCE RLS and ONE narrow select policy; no write policy.
 *     `agent_principals` is readable by every role and writable only by a connection that bypasses row-level security. FORCE is added by hand in the migration.
 * Side-effects: none (schema definitions only)
 * Links: https://node-template.cognidao.org/knowledge/agent-run-authority, https://node-template.cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** The two foreign-key targets a node supplies: its `users` table and its `billing_accounts` table (each needs a text `id` column). */
export interface AgentAuthorityRefs {
  readonly users: { readonly id: AnyPgColumn };
  readonly billingAccounts: { readonly id: AnyPgColumn };
}

/** Build the three authority tables over the node's own reference tables. */
export function defineAgentAuthoritySchema(refs: AgentAuthorityRefs) {
  /** A marked principal. `internal` rows are seeded for a graph to act as; `external` rows are outside agents and services; `org` rows are orgs (story.0038) whose owners an owner source decides. */
  const agentPrincipals = pgTable(
    "agent_principals",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      kind: text("kind").notNull(),
      slug: text("slug"),
      /** Only an `org` row: where its owners are read from (`repo-spec`, or `org-statement`) and the source key (the repo canonical https URL, or the org node origin). */
      ownerSourceKind: text("owner_source_kind"),
      ownerSourceRef: text("owner_source_ref"),
      userId: text("user_id")
        .notNull()
        .references(() => refs.users.id),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      check(
        "agent_principals_kind_canonical",
        sql`${table.kind} IN ('internal','external','org')`
      ),
      check(
        "agent_principals_org_has_owner_source",
        sql`${table.kind} <> 'org' OR (${table.ownerSourceKind} IS NOT NULL AND ${table.ownerSourceRef} IS NOT NULL)`
      ),
      check(
        "agent_principals_internal_has_slug",
        sql`${table.kind} <> 'internal' OR ${table.slug} IS NOT NULL`
      ),
      uniqueIndex("agent_principals_slug_unique").on(table.slug),
      uniqueIndex("agent_principals_user_id_unique").on(table.userId),
      // One org per owner source (one org per repo).
      uniqueIndex("agent_principals_org_source_unique")
        .on(table.ownerSourceKind, table.ownerSourceRef)
        .where(sql`${table.kind} = 'org'`),
      // Read-only for every role: slug and seeded user id are not secret, and the wallet-binding trigger must see
      // them whichever role binds. Writes stay deny-all for the app role (no write policy; FORCE RLS).
      pgPolicy("agent_principals_read", { for: "select", using: sql`true` }),
    ]
  ).enableRLS();

  /**
   * One grant row: a permission (scope) for an agent principal, on the node (`resource = 'node'`) or on one account (`'account'`).
   * Pending = `approved_by IS NULL` and not revoked (the agent asked; no approver has said yes). Live = approved, not revoked and, for an
   * account row, not past `expires_at`. Denied = never approved, revoked. Revoked = approved, then revoked. Expired is a state read from
   * `expires_at` (task.5465 R14), never a write. Only a live row opens a lock.
   * Account rows (task.5465): the account owner is the approver. A pending account row has no account until its owner decides it
   * (`account_id` is set in the decide statement, from an account the approver owns). One-time approval link: `link_hash` is sha256 of the
   * token (never the token), consumed by the decision.
   */
  const agentRoles = pgTable(
    "agent_roles",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      principalUserId: text("principal_user_id")
        .notNull()
        .references(() => refs.users.id),
      scope: text("scope").notNull(),
      approvedBy: text("approved_by").references(() => refs.users.id),
      /** Set when an approver approves. Null while pending or denied. */
      grantedAt: timestamp("granted_at", { withTimezone: true }),
      /** The agent that asked, for a row that began as a request. Null for a row an admin wrote directly. */
      requestedBy: text("requested_by").references(() => refs.users.id),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      /** What the row covers: the whole node, or one account. Every row before this column is a node row. */
      resource: text("resource").notNull().default("node"),
      /** The account an approved account row covers. Null on a node row and on a pending account row. */
      accountId: text("account_id").references(() => refs.billingAccounts.id),
      /** When an approved account row ends. Null = until Off (the default, like a node row). A row with an end keeps the expired state (R14). */
      expiresAt: timestamp("expires_at", { withTimezone: true }),
      /** sha256 of the one-time approval link token. The token is never stored. Null once consumed. */
      linkHash: text("link_hash"),
      linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
      linkConsumedAt: timestamp("link_consumed_at", { withTimezone: true }),
    },
    (table) => [
      // RELEASE B of two (task.0181 / task.5484): the old (principal, scope) index is gone. One live row per (principal, scope, account): one principal may hold the same
      // scope on several accounts (an org spender on two orgs). A node row and a pending account row have no account (the '' key). Every writer says a bare
      // `ON CONFLICT DO NOTHING`, so none names an index.
      uniqueIndex("agent_roles_live_account_unique")
        .on(table.principalUserId, table.scope, sql`coalesce(${table.accountId}, '')`)
        .where(sql`${table.revokedAt} IS NULL`),
      uniqueIndex("agent_roles_link_hash_unique").on(table.linkHash),
      index("agent_roles_principal_idx").on(table.principalUserId),
      check(
        "agent_roles_resource_canonical",
        sql`${table.resource} IN ('node','account')`
      ),
      check(
        "agent_roles_node_shape",
        sql`${table.resource} <> 'node' OR (${table.accountId} IS NULL AND ${table.expiresAt} IS NULL)`
      ),
      check(
        "agent_roles_account_live_shape",
        sql`${table.resource} <> 'account' OR ${table.approvedBy} IS NULL OR (${table.accountId} IS NOT NULL AND ${table.grantedAt} IS NOT NULL AND (${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.grantedAt}))`
      ),
      check(
        "agent_roles_no_self_approval",
        sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.principalUserId}`
      ),
      check(
        "agent_roles_link_consumed_has_no_hash",
        sql`${table.linkConsumedAt} IS NULL OR ${table.linkHash} IS NULL`
      ),
      // R11: an app-role connection sees only account rows that name it as the principal (the RLS function `agent_has_scope` reads them).
      // Writes stay service-role only: no write policy.
      pgPolicy("agent_roles_account_self_read", {
        for: "select",
        using: sql`${table.resource} = 'account' AND ${table.principalUserId} = current_setting('app.current_user_id', true)`,
      }),
    ]
  ).enableRLS();

  /**
   * One revocable agent key. `token_hash` is sha256 of the key; the key is never stored.
   * pending = `confirmed_at IS NULL` inside `pending_expires_at`. A rotation inserts a pending successor (`predecessor_id`); confirm
   * activates it and revokes the predecessor in one transaction. Revoking a row ends only that key.
   */
  const agentCredentials = pgTable(
    "agent_credentials",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      userId: text("user_id")
        .notNull()
        .references(() => refs.users.id),
      tokenHash: text("token_hash").notNull(),
      createdFrom: text("created_from").notNull(),
      predecessorId: uuid("predecessor_id"),
      issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      renewUntil: timestamp("renew_until", { withTimezone: true }).notNull(),
      pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
      confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      revokedReason: text("revoked_reason"),
      revokedBy: text("revoked_by"),
    },
    (table) => [
      foreignKey({
        columns: [table.predecessorId],
        foreignColumns: [table.id],
        name: "agent_credentials_predecessor_id_fk",
      }),
      check(
        "agent_credentials_created_from_canonical",
        sql`${table.createdFrom} IN ('spawn_grant','rotation','key_upgrade','binding_recovery','recovery_grant')`
      ),
      check(
        "agent_credentials_renew_after_expiry",
        sql`${table.renewUntil} > ${table.expiresAt}`
      ),
      uniqueIndex("agent_credentials_token_hash_unique").on(table.tokenHash),
      // One pending successor per predecessor: a second rotate supersedes (revokes) the first before it inserts.
      uniqueIndex("agent_credentials_one_pending_successor")
        .on(table.predecessorId)
        .where(sql`${table.confirmedAt} IS NULL AND ${table.revokedAt} IS NULL`),
      // Not partial: the v1 gate (`everConfirmed`) reads revoked rows too, on every signed-key-authenticated request.
      index("agent_credentials_user_idx").on(table.userId),
    ]
  ).enableRLS();

  /**
   * A payer binding (story.0038 phase 2): the subject's runs are billed to `billing_account_id` once an owner of that account approves. Pending = `approved_by IS NULL`
   * and not revoked. Live = approved and not revoked. One open (pending or live) row per subject. Never deleted: `revoked_at` ends it. The binding is the consent
   * (PAYER_IS_AUTHORIZED). Service-role only: ENABLE + FORCE RLS and no policy (FORCE is added by hand, `migrations/payer_bindings.sql`).
   */
  const payerBindings = pgTable(
    "payer_bindings",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      subjectUserId: text("subject_user_id")
        .notNull()
        .references(() => refs.users.id),
      billingAccountId: text("billing_account_id")
        .notNull()
        .references(() => refs.billingAccounts.id),
      approvedBy: text("approved_by").references(() => refs.users.id),
      approvedAt: timestamp("approved_at", { withTimezone: true }),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      revokedBy: text("revoked_by").references(() => refs.users.id),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      uniqueIndex("payer_bindings_open_per_subject")
        .on(table.subjectUserId)
        .where(sql`${table.revokedAt} IS NULL`),
      index("payer_bindings_account_idx").on(table.billingAccountId),
      check(
        "payer_bindings_no_self_approval",
        sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.subjectUserId}`
      ),
      check(
        "payer_bindings_approval_is_paired",
        sql`(${table.approvedBy} IS NULL) = (${table.approvedAt} IS NULL)`
      ),
    ]
  ).enableRLS();

  /**
   * One org's account on this node (task.0181, `org-account-lifecycle`): the node's own record of an org that connected. The org is a DAO and the node it runs, keyed
   * by the node's origin (the `agent_principals` org row's owner source, kind `org-statement`). Its admins are NEVER stored as authority: `admins` is the list read from
   * the last verified statement, kept for the history's old-and-new comparison and for display; authority reads the statement again (cached at most 5 minutes).
   * `statement_version` only rises. Suspension is set and cleared by this node's admins and never touches the org's admins. Service-role only: ENABLE + FORCE RLS, no policy.
   */
  const orgAccounts = pgTable(
    "org_accounts",
    {
      orgUserId: text("org_user_id")
        .primaryKey()
        .references(() => refs.users.id),
      billingAccountId: text("billing_account_id")
        .notNull()
        .references(() => refs.billingAccounts.id),
      nodeId: text("node_id").notNull(),
      origin: text("origin").notNull(),
      dao: text("dao"),
      admins: text("admins").array().notNull().default(sql`'{}'::text[]`),
      services: text("services").array().notNull().default(sql`'{}'::text[]`),
      statementVersion: bigint("statement_version", { mode: "number" }).notNull(),
      statementCommit: text("statement_commit"),
      fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
      connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
      /** Set by the org's signed disconnect; a later connect clears it. Its services stop at the next call. */
      disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
      suspendedAt: timestamp("suspended_at", { withTimezone: true }),
      suspendedBy: text("suspended_by").references(() => refs.users.id),
      suspendReason: text("suspend_reason"),
    },
    (table) => [
      uniqueIndex("org_accounts_origin_unique").on(table.origin),
      // One org per node: two origins can never claim the same node id.
      uniqueIndex("org_accounts_node_id_unique").on(table.nodeId),
      uniqueIndex("org_accounts_billing_account_unique").on(table.billingAccountId),
      check(
        "org_accounts_suspension_is_complete",
        sql`(${table.suspendedAt} IS NULL) = (${table.suspendedBy} IS NULL) AND (${table.suspendedAt} IS NULL) = (${table.suspendReason} IS NULL)`
      ),
    ]
  ).enableRLS();

  /**
   * The org account's history (EVERY_ACT_LOGGED): one row per act, written in the same transaction as the act. APPEND ONLY: a trigger refuses UPDATE, DELETE and TRUNCATE
   * for every role, the owner included (`migrations/org_accounts.sql`). `actor` is always a user id: the admin's, or the org's `org-connect` service principal (a real `users` row)
   * when the org's own signed statement or disconnect is the actor, with the org's origin in `detail`. `detail` carries the old and new admin list on an admin change, the wallet and scope on a spend grant. Service-role only: ENABLE + FORCE RLS.
   */
  const orgEvents = pgTable(
    "org_events",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgUserId: text("org_user_id")
        .notNull()
        .references(() => refs.users.id),
      act: text("act").notNull(),
      actor: text("actor").notNull(),
      reason: text("reason"),
      detail: jsonb("detail"),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      index("org_events_org_time_idx").on(table.orgUserId, table.createdAt),
      // EXACTLY_ONCE_FUNDING: a payment funds an org once. The payment's own id (`detail.paymentRef`) is unique per org among `org.funded` rows, so a repeated webhook writes nothing.
      uniqueIndex("org_events_funded_payment_unique")
        .on(table.orgUserId, sql`(${table.detail}->>'paymentRef')`)
        .where(sql`${table.act} = 'org.funded'`),
      check(
        "org_events_act_canonical",
        sql`${table.act} IN ('org.connected','org.admins_changed','org.services_changed','org.disconnected','org.spend_granted','org.spend_claimed','org.spend_removed','org.suspended','org.restored','org.funded')`
      ),
    ]
  ).enableRLS();

  /**
   * A spend grant held by wallet until that wallet first signs in (`org-account-lifecycle`, step 3): an org admin names a wallet that has no `users` row here yet. At the
   * wallet's first sign-in the hold becomes an ordinary account-resource `agent_roles` row (`claimed_at` set). Never deleted. Service-role only: ENABLE + FORCE RLS.
   */
  const orgWalletHolds = pgTable(
    "org_wallet_holds",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgUserId: text("org_user_id")
        .notNull()
        .references(() => refs.users.id),
      /** Lowercased `0x` address. */
      wallet: text("wallet").notNull(),
      scope: text("scope").notNull(),
      grantedBy: text("granted_by")
        .notNull()
        .references(() => refs.users.id),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      claimedAt: timestamp("claimed_at", { withTimezone: true }),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
    },
    (table) => [
      uniqueIndex("org_wallet_holds_open_unique")
        .on(table.orgUserId, table.wallet, table.scope)
        .where(sql`${table.claimedAt} IS NULL AND ${table.revokedAt} IS NULL`),
      index("org_wallet_holds_wallet_idx").on(table.wallet),
    ]
  ).enableRLS();

  /**
   * The ORG's own list of the nodes it connected to (task.0181): one row per target origin, kept by the org's node so its governance page shows each account's status
   * (the target returns the status in every connect and disconnect answer). Not authority: it decides nothing on any node. Every write names the acting admin (`updated_by`). Service-role only: ENABLE + FORCE RLS.
   */
  const orgConnections = pgTable(
    "org_connections",
    {
      origin: text("origin").primaryKey(),
      nodeId: text("node_id").notNull(),
      /** The status the target last answered: connected, disconnected, suspended, or unreachable. */
      status: text("status").notNull(),
      reason: text("reason"),
      /** Who last wrote the row: the admin (of this org's node) who connected or disconnected, or this org's own `org-connect` service principal when a re-post refreshed it. Every write has an actor. */
      updatedBy: text("updated_by")
        .notNull()
        .references(() => refs.users.id),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      /** The version of THIS node's statement (its build's commit time) the target ACKNOWLEDGED: it answered that it applied a statement and holds a version at least this high. Never lowered; null until then. The boot re-post finds the nodes below the running build's version. */
      statementVersion: bigint("statement_version", { mode: "number" }),
      /** The last operation this org sent to the node: `connect` or `disconnect`. The boot re-post asks an `unreachable` node only when it was a connect (never one the org was disconnecting). */
      lastOp: text("last_op").notNull().default("connect"),
    },
    (table) => [
      check(
        "org_connections_status_canonical",
        sql`${table.status} IN ('connected','disconnected','suspended','unreachable')`
      ),
      check(
        "org_connections_last_op_canonical",
        sql`${table.lastOp} IN ('connect','disconnect')`
      ),
    ]
  ).enableRLS();

  /**
   * The service principal of each service an org's statement enables (task.0181): `service_user_id` is the id `servicePrincipalId(origin, service)` derives, written at connect and
   * refresh, so a calling service is found by one primary-key read instead of hashing every org's services. No foreign key on the service user: its `users` row exists only once it asks.
   * Service-role only: ENABLE + FORCE RLS.
   */
  const orgServicePrincipals = pgTable(
    "org_service_principals",
    {
      serviceUserId: text("service_user_id").primaryKey(),
      orgUserId: text("org_user_id")
        .notNull()
        .references(() => refs.users.id),
      service: text("service").notNull(),
    },
    (table) => [uniqueIndex("org_service_principals_org_service_unique").on(table.orgUserId, table.service)]
  ).enableRLS();

  /** The replay store of the org connect door: one row per seen assertion `jti` until it expires, shared by every replica. Service-role only: ENABLE + FORCE RLS. */
  const orgConnectJtis = pgTable(
    "org_connect_jtis",
    {
      jti: text("jti").primaryKey(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (table) => [index("org_connect_jtis_expires_idx").on(table.expiresAt)]
  ).enableRLS();

  return {
    agentPrincipals,
    agentRoles,
    agentCredentials,
    payerBindings,
    orgAccounts,
    orgEvents,
    orgWalletHolds,
    orgConnections,
    orgServicePrincipals,
    orgConnectJtis,
  };
}

export * from "./internal-principals";
