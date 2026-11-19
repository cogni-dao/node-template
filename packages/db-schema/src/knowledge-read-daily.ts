// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/knowledge-read-daily`
 * Purpose: Write-time daily counters of agent atom reads — the source of the knowledge read-miss KPI and the
 *   heavy-read scrutiny list (story.0061).
 * Scope: Schema only. The app's batched recorder upserts it; the calculator reads it with static SQL.
 * Invariants:
 * - KEYS_NOT_TRAFFIC: one row per (day, atom, principal, class); reads only increment counters, and the writer folds
 *   invalid or excess missed ids into two sentinel keys, so rows grow with distinct keys, never with traffic.
 * - AGENTS_ONLY: no human, list or search rows; no query text or bodies.
 * - FACTS_NOT_REFERENCES: no foreign keys, so an upsert never fails on identity.
 * - SERVICE_ROLE_ONLY: RLS ENABLE + FORCE with no policy (deny-all for app_user); FORCE is hand-written in the migration.
 * Side-effects: none (schema definitions only)
 * Links: https://node-template.cognidao.org/knowledge/knowledge-usage-telemetry
 * @public
 */

import { sql } from "drizzle-orm";
import {
	check,
	date,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export const knowledgeReadDaily = pgTable(
	"knowledge_read_daily",
	{
		/** UTC day of the reads. */
		day: date("day").notNull(),
		atomId: text("atom_id").notNull(),
		principalId: text("principal_id").notNull(),
		principalClass: text("principal_class").notNull(),
		okCount: integer("ok_count").notNull().default(0),
		failCount: integer("fail_count").notNull().default(0),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		primaryKey({
			columns: [table.day, table.atomId, table.principalId, table.principalClass],
		}),
		check(
			"knowledge_read_daily_principal_class_check",
			sql`${table.principalClass} IN ('internal_run', 'external_agent')`,
		),
	],
).enableRLS();

/**
 * Write-time (atom, work item) pairs from work-item PATCH `cites` (story.0061): the link from a heavily read atom
 * to the items that used it. One row per pair, inserted once (ON CONFLICT DO NOTHING), so rows grow with distinct
 * pairs, never with patches. Same access rule as knowledge_read_daily: service role only, FORCE in the migration.
 */
export const knowledgeCitePairs = pgTable(
	"knowledge_cite_pairs",
	{
		atomId: text("atom_id").notNull(),
		workItemId: text("work_item_id").notNull(),
		/** The item revision the first cite of this atom produced; review verdicts are ordered against it. */
		firstItemRevision: integer("first_item_revision").notNull(),
		firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.atomId, table.workItemId] })],
).enableRLS();
