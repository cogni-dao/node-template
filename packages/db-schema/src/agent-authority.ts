// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-authority`
 * Purpose: Runtime agent authority tables: internal agent principals and node role rows.
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants` (raw SQL over an injected client).
 * Invariants:
 *   - An internal principal row points at a seeded `users` row that has no credential.
 *   - CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: `agent_credentials` rows belong only to a user with an `external` `agent_principals` row
 *     (a trigger in the migration enforces it).
 *   - ROLE_ROWS_ARE_SOFT_REVOKED: a role row is never deleted; `revoked_at` ends it. One live row per (principal, scope).
 *   - ONE_GRANT_ROW (task.5465): node and account grants are one table, `agent_roles`; `resource` and `account_id` say which.
 *   - TOKEN_HASH_ONLY / STATE_IS_DERIVED: `agent_credentials` stores sha256 of the key and timestamps only; state (pending, active,
 *     renew_only, expired, revoked) is derived by the SQL function `agent_credential_state` (migration), never stored.
 *   - SERVICE_ROLE_ONLY_WRITES: `agent_credentials` has ENABLE + FORCE RLS and no policy (deny-all for the app role). `agent_roles` has ENABLE + FORCE RLS
 *     and ONE narrow select policy (an account row naming the connection's own user as principal); no write policy.
 *     `agent_principals` is readable by every role (its select policy) and writable only by a BYPASSRLS service
 *     connection. FORCE is added by hand in the migration.
 *   - AGENT_WALLET_IS_NOT_A_PAYEE (a payout guard, enforced in the database; it does not decide who may be admin): an agent principal may bind a wallet, but a trigger
 *     on `epoch_distribution_leaves` and `distribution_settlement_leaves` (migration 0043) refuses a payout leaf whose account is a wallet an agent principal owns.
 * Side-effects: none (schema definitions only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { defineAgentAuthoritySchema } from "@cogni/agent-grants/schema";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { billingAccounts, users } from "./refs";

/**
 * `agent_principals`, `agent_roles` and `agent_credentials` come from `@cogni/agent-grants/schema` over this node's own `users` and `billing_accounts`
 * (task.0175); the node's `db:generate` writes their migration. `payer_bindings` stays here until task.0181 moves it into the package.
 */
export const { agentPrincipals, agentRoles, agentCredentials } =
  defineAgentAuthoritySchema({ users, billingAccounts });

/**
 * A payer binding (story.0038 phase 2): the subject's runs are billed to `billing_account_id` once an owner of that account approves. Pending = `approved_by IS NULL`
 * and not revoked. Live = approved and not revoked. One open (pending or live) row per subject. Never deleted: `revoked_at` ends it. The binding is the consent
 * (PAYER_IS_AUTHORIZED); there is no spend scope. Service-role only: ENABLE + FORCE RLS and no policy (FORCE is added by hand in the migration).
 */
export const payerBindings = pgTable(
  "payer_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectUserId: text("subject_user_id")
      .notNull()
      .references(() => users.id),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id),
    approvedBy: text("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => users.id),
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
