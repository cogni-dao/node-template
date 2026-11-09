// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-authority`
 * Purpose: Runtime agent authority tables: internal agent principals and node role rows.
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants` (raw SQL over an injected client).
 * Invariants:
 *   - AGENTS_HOLD_NO_WALLET: an internal principal row points at a seeded `users` row with no wallet and has no credential.
 *   - CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: no credential table exists here; a later one may reference only an `external` row.
 *   - ROLE_ROWS_ARE_SOFT_REVOKED: a role row is never deleted; `revoked_at` ends it. One live row per (principal, scope).
 *   - NO_ACCOUNT_GRANTS: account scopes are out of scope; no account-grant table ships.
 *   - SERVICE_ROLE_ONLY_WRITES: `agent_roles` has ENABLE + FORCE RLS and no policy (deny-all for the app role).
 *     `agent_principals` is readable by every role (its select policy) and writable only by a BYPASSRLS service
 *     connection. FORCE is added by hand in the migration.
 *   - AGENTS_HOLD_NO_WALLET (a payout guard, enforced in the database; it does not decide who may be admin): a trigger on `user_bindings` (migration) refuses a wallet
 *     binding for any user that has an `agent_principals` row, on every binding path.
 * Side-effects: none (schema definitions only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
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

import { users } from "./refs";

/** A marked agent. `internal` rows are seeded for a graph to act as; `external` rows come from redeemed spawn grants (later). */
export const agentPrincipals = pgTable(
  "agent_principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    slug: text("slug"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_principals_kind_canonical",
      sql`${table.kind} IN ('internal','external')`
    ),
    check(
      "agent_principals_internal_has_slug",
      sql`${table.kind} <> 'internal' OR ${table.slug} IS NOT NULL`
    ),
    uniqueIndex("agent_principals_slug_unique").on(table.slug),
    uniqueIndex("agent_principals_user_id_unique").on(table.userId),
    // Read-only for every role: slug and seeded user id are not secret, and the wallet-binding trigger must see
    // them whichever role binds. Writes stay deny-all for the app role (no write policy; FORCE RLS).
    pgPolicy("agent_principals_read", { for: "select", using: sql`true` }),
  ]
).enableRLS();

/** A DAO-admin-approved node role for an agent principal. Revoked softly. */
export const agentRoles = pgTable(
  "agent_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalUserId: text("principal_user_id")
      .notNull()
      .references(() => users.id),
    scope: text("scope").notNull(),
    approvedBy: text("approved_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("agent_roles_live_unique")
      .on(table.principalUserId, table.scope)
      .where(sql`${table.revokedAt} IS NULL`),
    index("agent_roles_principal_idx").on(table.principalUserId),
  ]
).enableRLS();
