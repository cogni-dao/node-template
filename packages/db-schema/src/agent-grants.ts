// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-grants`
 * Purpose: Scoped, revocable agent access — revocable agent credentials,
 *   expiring account capability grants, and owner-approved access requests.
 * Scope: Operational Postgres schema only. Lifecycle and the authorize()
 *   decision live in `@cogni-dao/agent-grants`. Ported from Poly
 *   (950e155, packages/db-schema/src/agent-{capability-grants,access-requests}.ts).
 * Invariants:
 *   - NODE_DECLARED_SCOPES: scopes are plain strings validated at approval
 *     against the node's declared scope list. There is NO database scope CHECK,
 *     so a scope cannot drift between a constraint and the declaration.
 *   - CREDENTIAL_HASH_ONLY: agent_credentials stores sha256(key) only; a row
 *     with revoked_at set denies the key on every request.
 *   - OWNER_WRITES / GRANTEE_READS: grants are inserted/updated only by the
 *     account owner; a grantee reads only grants issued to it.
 *   - NO_POLICY_CYCLE: the grant SELECT policy never reads billing_accounts
 *     (owner reads via created_by_user_id, which the INSERT policy pins to the
 *     owner), because billing_accounts' delegated-read policy reads grants
 *     through `agent_has_scope()` (migration 0034).
 *   - SINGLE_CURRENT_GRANT: at most one non-revoked grant per (account, grantee).
 * Side-effects: none (schema only)
 * Links: story.5115, knowledge node-capability-grants-standard
 * @public
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { billingAccounts, users } from "./refs";

/**
 * Revocable agent credentials. Service-role only (ENABLE + FORCE RLS with no
 * policy = deny-all for the app role): written by register, read by the
 * bearer resolver, revoked by self-revoke — all via the BYPASSRLS service db.
 */
export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("agent_credentials_key_hash_idx").on(table.keyHash),
    index("agent_credentials_user_idx").on(table.userId),
  ]
).enableRLS();

export const agentCapabilityGrants = pgTable(
  "agent_capability_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    granteePrincipalId: text("grantee_principal_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_capability_grants_scopes_nonempty",
      sql`cardinality(${table.scopes}) > 0`
    ),
    check(
      "agent_capability_grants_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    check(
      "agent_capability_grants_revocation_audit",
      sql`(${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL)`
    ),
    uniqueIndex("agent_capability_grants_current_idx")
      .on(table.billingAccountId, table.granteePrincipalId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("agent_capability_grants_grantee_active_idx").on(
      table.granteePrincipalId,
      table.expiresAt
    ),
    index("agent_capability_grants_account_created_idx").on(
      table.billingAccountId,
      table.createdAt
    ),
    pgPolicy("agent_capability_grants_select", {
      for: "select",
      using: sql`${table.createdByUserId} = current_setting('app.current_user_id', true)
        OR ${table.granteePrincipalId} = current_setting('app.current_user_id', true)`,
    }),
    pgPolicy("agent_capability_grants_insert", {
      for: "insert",
      withCheck: sql`${table.billingAccountId} IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      ) AND ${table.createdByUserId} = current_setting('app.current_user_id', true)`,
    }),
    pgPolicy("agent_capability_grants_update", {
      for: "update",
      using: sql`${table.billingAccountId} IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      )`,
      withCheck: sql`${table.billingAccountId} IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      )`,
    }),
  ]
).enableRLS();

export const agentAccessRequests = pgTable(
  "agent_access_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requesterPrincipalId: text("requester_principal_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requesterDisplayName: text("requester_display_name"),
    requestedScopes: text("requested_scopes").array().notNull(),
    grantExpiresAt: timestamp("grant_expires_at", {
      withTimezone: true,
    }).notNull(),
    approvalTokenHash: text("approval_token_hash").notNull(),
    approvalTokenExpiresAt: timestamp("approval_token_expires_at", {
      withTimezone: true,
    }).notNull(),
    status: text("status").notNull().default("pending"),
    billingAccountId: text("billing_account_id").references(
      () => billingAccounts.id,
      { onDelete: "cascade" }
    ),
    approvedGrantId: uuid("approved_grant_id").references(
      () => agentCapabilityGrants.id
    ),
    decisionByUserId: text("decision_by_user_id").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_access_requests_status_canonical",
      sql`${table.status} IN ('pending','approved','denied','expired','revoked')`
    ),
    check(
      "agent_access_requests_scopes_nonempty",
      sql`cardinality(${table.requestedScopes}) > 0`
    ),
    uniqueIndex("agent_access_requests_token_hash_idx").on(
      table.approvalTokenHash
    ),
    uniqueIndex("agent_access_requests_requester_pending_idx")
      .on(table.requesterPrincipalId)
      .where(sql`${table.status} = 'pending'`),
    pgPolicy("agent_access_requests_select", {
      for: "select",
      using: sql`${table.requesterPrincipalId} = current_setting('app.current_user_id', true)
        OR ${table.billingAccountId} IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        )
        OR (
          ${table.status} = 'pending'
          AND ${table.approvalTokenHash} = current_setting('app.agent_access_request_token_hash', true)
          AND ${table.approvalTokenExpiresAt} > now()
        )`,
    }),
    pgPolicy("agent_access_requests_insert", {
      for: "insert",
      withCheck: sql`${table.requesterPrincipalId} = current_setting('app.current_user_id', true)
        AND ${table.status} = 'pending'
        AND ${table.billingAccountId} IS NULL
        AND ${table.approvedGrantId} IS NULL
        AND ${table.decisionByUserId} IS NULL`,
    }),
    pgPolicy("agent_access_requests_requester_expire", {
      for: "update",
      using: sql`${table.requesterPrincipalId} = current_setting('app.current_user_id', true)
        AND ${table.status} = 'pending'
        AND ${table.approvalTokenExpiresAt} <= now()`,
      withCheck: sql`${table.requesterPrincipalId} = current_setting('app.current_user_id', true)
        AND ${table.status} = 'expired'
        AND ${table.billingAccountId} IS NULL
        AND ${table.approvedGrantId} IS NULL
        AND ${table.decisionByUserId} IS NULL`,
    }),
    pgPolicy("agent_access_requests_owner_update", {
      for: "update",
      using: sql`${table.billingAccountId} IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        ) OR (
          ${table.status} = 'pending'
          AND ${table.approvalTokenHash} = current_setting('app.agent_access_request_token_hash', true)
          AND ${table.approvalTokenExpiresAt} > now()
        )`,
      withCheck: sql`${table.billingAccountId} IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        )
        AND ${table.decisionByUserId} = current_setting('app.current_user_id', true)`,
    }),
  ]
).enableRLS();

export type AgentCredentialRow = typeof agentCredentials.$inferSelect;
export type AgentCapabilityGrantRow = typeof agentCapabilityGrants.$inferSelect;
export type AgentAccessRequestRow = typeof agentAccessRequests.$inferSelect;
