// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/org-accounts`
 * Purpose: Org account tables (task.0181): invites, one-time link codes and node links. The org itself is a `users` row, an `agent_principals` row of kind `org` and one
 *   `billing_accounts` row; a person's role is an `agent_roles` row (`resource = 'account'`, scope `org:owner` or `org:admin`).
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants` (raw SQL over an injected service-role client).
 * Invariants:
 *   - INVITE_GRANTS_NOTHING: an invite names a wallet and a role; the grant row is written only when the invited person accepts. One open invite per (org, wallet); single use.
 *   - CODE_IS_HASHED_AND_SINGLE_USE: `org_link_codes` stores sha256 of the code, bound to one org and one https origin, valid 15 minutes, burned once.
 *   - ONE_OPEN_LINK_PER_ISSUER: a unique partial index on `issuer WHERE closed_at IS NULL`. A closed link row is kept (it is how the payer resolver tells `org_link_closed` apart).
 *   - SERVICE_ROLE_ONLY: all three tables have ENABLE + FORCE RLS and no policy (FORCE is added by hand in the migration).
 * Side-effects: none (schema definitions only)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./refs";

/** A pending invitation to hold a role on an org. The wallet is lowercase; `scope` is `org:owner` or `org:admin`. */
export const orgInvites = pgTable(
  "org_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgUserId: text("org_user_id")
      .notNull()
      .references(() => users.id),
    wallet: text("wallet").notNull(),
    scope: text("scope").notNull(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by").references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check("org_invites_scope_canonical", sql`${table.scope} IN ('org:owner','org:admin')`),
    check("org_invites_accept_is_paired", sql`(${table.acceptedAt} IS NULL) = (${table.acceptedBy} IS NULL)`),
    uniqueIndex("org_invites_open_per_wallet")
      .on(table.orgUserId, table.wallet)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    index("org_invites_wallet_idx").on(table.wallet),
  ]
).enableRLS();

/** A one-time link code an org owner made for one other node's origin. Only its sha256 is stored. */
export const orgLinkCodes = pgTable(
  "org_link_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgUserId: text("org_user_id")
      .notNull()
      .references(() => users.id),
    origin: text("origin").notNull(),
    codeHash: text("code_hash").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("org_link_codes_hash_unique").on(table.codeHash), index("org_link_codes_org_idx").on(table.orgUserId)]
).enableRLS();

/**
 * A node link: another node (`issuer`, its https origin) acts as `org_user_id` for `services`. One open link per issuer on a node. `closed_at` ends it; the row is never deleted.
 * The link writes one approved `payer_bindings` row per service principal (`payer_bindings.link_id` names this row).
 */
export const orgLinks = pgTable(
  "org_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgUserId: text("org_user_id")
      .notNull()
      .references(() => users.id),
    issuer: text("issuer").notNull(),
    services: text("services").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("org_links_open_per_issuer")
      .on(table.issuer)
      .where(sql`${table.closedAt} IS NULL`),
    index("org_links_org_idx").on(table.orgUserId),
    check("org_links_close_is_paired", sql`(${table.closedAt} IS NULL) = (${table.closedBy} IS NULL)`),
  ]
).enableRLS();
