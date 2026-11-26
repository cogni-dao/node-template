// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-authority`
 * Purpose: Runtime agent authority tables: internal agent principals, node role rows, revocable credentials, payer bindings and org accounts.
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants` (raw SQL over an injected client).
 * Invariants:
 *   - An internal principal row points at a seeded `users` row that has no credential.
 *   - CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: `agent_credentials` rows belong only to a user with an `external` `agent_principals` row
 *     (a trigger in the migration enforces it).
 *   - ROLE_ROWS_ARE_SOFT_REVOKED: a role row is never deleted; `revoked_at` ends it. One live row per (principal, scope).
 *   - ONE_GRANT_ROW (task.5465): node and account grants are one table, `agent_roles`; `resource` and `account_id` say which.
 *   - TOKEN_HASH_ONLY / STATE_IS_DERIVED: `agent_credentials` stores sha256 of the key and timestamps only; state (pending, active,
 *     renew_only, expired, revoked) is derived by the SQL function `agent_credential_state` (migration), never stored.
 *   - SERVICE_ROLE_ONLY_WRITES: `agent_credentials`, `payer_bindings` and the six org tables have ENABLE + FORCE RLS and no policy (deny-all for the app role). `agent_roles` has ENABLE + FORCE RLS
 *     and ONE narrow select policy (an account row naming the connection's own user as principal); no write policy.
 *     `agent_principals` is readable by every role (its select policy) and writable only by a BYPASSRLS service
 *     connection. FORCE is added by hand in the migration.
 *   - EVERY_ACT_LOGGED (task.0181): `org_events` is append only (a trigger in the migration refuses UPDATE, DELETE and TRUNCATE).
 *   - AGENT_WALLET_IS_NOT_A_PAYEE (a payout guard, enforced in the database; it does not decide who may be admin): an agent principal may bind a wallet, but a trigger
 *     on `epoch_distribution_leaves` and `distribution_settlement_leaves` (migration 0043) refuses a payout leaf whose account is a wallet an agent principal owns.
 * Side-effects: none (schema definitions only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { defineAgentAuthoritySchema } from "@cogni/agent-grants/schema";

import { billingAccounts, users } from "./refs";

/**
 * Every table here comes from `@cogni/agent-grants/schema` over this node's own `users` and `billing_accounts`; the node's `db:generate` writes their migrations
 * (task.0175 moved the principals, roles and credentials; task.0181 moved `payer_bindings` and added the org tables).
 */
export const {
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
} = defineAgentAuthoritySchema({ users, billingAccounts });
