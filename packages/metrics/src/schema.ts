// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Postgres table definitions read and written by `./adapters/postgres`.
 * Definitions only: each node re-exports these from its db-schema, generates and
 * runs its own migrations, and owns its pool. drizzle-kit does not emit FORCE RLS,
 * so a node appends METRIC_FORCE_RLS_SQL to the migration that creates the tables.
 */
import { sql } from "drizzle-orm";
import {
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
export const metricObservations = pgTable(
	"metric_observations",
	{
		id: uuid("id").primaryKey(),
		scope: text("scope").notNull(),
		metricId: text("metric_id").notNull(),
		scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
		definitionHash: text("definition_hash").notNull(),
		evaluationAt: timestamp("evaluation_at", { withTimezone: true }).notNull(),
		snapshot: jsonb("snapshot").notNull(),
		observation: jsonb("observation").notNull(),
		status: text("status").notNull(),
		leaseToken: uuid("lease_token"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
	},
	(t) => [
		index("metric_scheduled_slot").on(
			t.scope,
			t.metricId,
			t.definitionHash,
			t.scheduledFor,
		),
		uniqueIndex("metric_observation_slot").on(
			t.scope,
			t.metricId,
			t.definitionHash,
			t.evaluationAt,
		),
	],
).enableRLS();
export const metricRefreshCursors = pgTable("metric_refresh_cursors", {
	scope: text("scope").primaryKey(),
	lastMetricId: text("last_metric_id").notNull(),
}).enableRLS();
/** Hand-appended migration statements; service-role access only. */
export const METRIC_FORCE_RLS_SQL = [
	'ALTER TABLE "metric_observations" FORCE ROW LEVEL SECURITY;',
	'ALTER TABLE "metric_refresh_cursors" FORCE ROW LEVEL SECURITY;',
] as const;

/**
 * Write-time daily counters of agent atom reads (story.0061): one row per (day, atom, principal, class); reads only
 * increment it, so rows grow with distinct keys, never with traffic. Source of the read-miss KPI. No foreign keys.
 */
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
 * Write-time (atom, work item) pairs from work-item PATCH `cites` (story.0061), inserted once per pair, so rows grow
 * with distinct pairs, never with patches.
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
/** Hand-appended migration statements for the usage tables; service-role access only. */
export const KNOWLEDGE_USAGE_FORCE_RLS_SQL = [
	'ALTER TABLE "knowledge_read_daily" FORCE ROW LEVEL SECURITY;',
	'ALTER TABLE "knowledge_cite_pairs" FORCE ROW LEVEL SECURITY;',
] as const;
