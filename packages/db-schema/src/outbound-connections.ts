// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/outbound-connections`
 * Purpose: This node's OWN side of connect from home (story.0038, 0.9.0): what it last told each provider it is connected to, so the signed `seq` keeps rising across restarts.
 * Scope: Schema only. One row per provider origin (a target of `.cogni/service-links.yaml`). Node-local: it is not part of the published agent-grants migration template.
 * Invariants:
 *   - SEQ_RISES_ACROSS_RESTARTS: `seq` is the last value this node signed; the next connect or disconnect takes `seq + 1` in one atomic update before it signs.
 *   - A row is this node's memory of its own act, never the provider's state: the provider's record is the authority for admission.
 *   - Service-role only: ENABLE + FORCE RLS and no policy (FORCE is added by hand in the migration). No FK to `users`.
 * Side-effects: none (schema definitions only)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { bigint, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const outboundConnections = pgTable(
  "outbound_connections",
  {
    /** The provider's canonical https origin, as the target lists it. */
    targetOrigin: text("target_origin").primaryKey(),
    /** What this node last asked: `connected` or `disconnected`. */
    status: text("status").notNull(),
    /** The cap this node last signed, in integer credits. */
    cap: bigint("cap", { mode: "number" }).notNull(),
    /** The last `seq` this node signed. */
    seq: bigint("seq", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "outbound_connections_status_canonical",
      sql`${table.status} IN ('connected','disconnected')`
    ),
    check("outbound_connections_cap_nonnegative", sql`${table.cap} >= 0`),
    check("outbound_connections_seq_nonnegative", sql`${table.seq} >= 0`),
  ]
).enableRLS();
