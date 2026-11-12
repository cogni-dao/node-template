// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-service-enrollments`
 * Purpose: One row per service enrollment: a signed request from a trusted home node (for example the operator's git-review) that
 *   became a pending ask plus a device code. The key itself is never stored here (`agent_credentials` keeps its sha256).
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants/enrollment` (raw SQL over an injected client).
 * Invariants:
 *   - ONE_USE_TOKEN: `jti` is unique. A second POST of one enrollment token inserts nothing and answers 401 `replayed_token`.
 *   - DEVICE_CODE_HASH_ONLY: the device code is 32 random bytes shown once; only its sha256 is stored.
 *   - SERVICE_ROLE_ONLY: ENABLE + FORCE RLS and no policy (hand-written in the migration): deny-all for the app role.
 *   - `cnf_jwk` is the home's PUBLIC key (X25519). A key is sealed to it; nothing secret is stored.
 *   - STATE: `open` until the key it issued is confirmed (`redeemed`), the admin dismisses the ask (`denied`) or the code lapses or a
 *     newer enrollment replaces it (`expired`).
 * Side-effects: none (schema definitions only)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

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

import { agentCredentials } from "./agent-authority";
import { users } from "./refs";

export const agentServiceEnrollments = pgTable(
  "agent_service_enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The enrollment token's `jti`. Unique: the replay wall. */
    jti: text("jti").notNull(),
    /** The verified issuer origin, for example `https://cognidao.org`. */
    issuer: text("issuer").notNull(),
    service: text("service").notNull(),
    principalUserId: text("principal_user_id")
      .notNull()
      .references(() => users.id),
    /** The one permission asked for, for example `knowledge:read`. */
    scope: text("scope").notNull(),
    deviceCodeHash: text("device_code_hash").notNull(),
    /** The public key (`cnf.jwk`) the key is sealed to, as JSON text (public: no secret is stored here). */
    cnfJwk: text("cnf_jwk").notNull(),
    status: text("status").notNull().default("open"),
    /** The pending key most recently issued for this enrollment. A repeat poll before confirm replaces it. */
    credentialId: uuid("credential_id").references(() => agentCredentials.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    historicalConfirmedAt: timestamp("historical_confirmed_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "agent_service_enrollments_status_canonical",
      sql`${table.status} IN ('open','redeemed','denied','expired')`
    ),
    uniqueIndex("agent_service_enrollments_jti_unique").on(table.jti),
    uniqueIndex("agent_service_enrollments_device_code_hash_unique").on(
      table.deviceCodeHash
    ),
    index("agent_service_enrollments_credential_idx").on(table.credentialId),
    index("agent_service_enrollments_principal_idx").on(table.principalUserId),
    index("agent_service_enrollments_open_expiry_idx")
      .on(table.expiresAt, table.id)
      .where(sql`${table.status} = 'open'`),
    index("agent_service_enrollments_open_principal_idx")
      .on(table.principalUserId, table.expiresAt, table.id)
      .where(sql`${table.status} = 'open'`),
  ]
).enableRLS();
