// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Operational metric evidence. Service-role access; migrations and pool ownership stay node-local. */
import {
	index,
	jsonb,
	pgTable,
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
