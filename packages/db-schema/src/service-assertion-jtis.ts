// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/service-assertion-jtis`
 * Purpose: The durable replay store of signed service assertions (`createPostgresReplayStore` in `@cogni-dao/agent-grants/service-auth`).
 * Scope: Schema only.
 * Invariants:
 *   - DURABLE_REPLAY: `jti` (issuer-qualified) is the primary key, so a replayed assertion is refused after a restart and by every replica. Rows are pruned after `expires_at`.
 *   - SERVICE_ROLE_ONLY: ENABLE + FORCE RLS and no policy (FORCE is added by hand in the migration).
 * Side-effects: none (schema definitions only)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const serviceAssertionJtis = pgTable(
  "service_assertion_jtis",
  {
    jti: text("jti").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("service_assertion_jtis_expires_idx").on(table.expiresAt)]
).enableRLS();
