// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Node composition. The calculators, budgets and source allow-list are
 * published in @cogni-dao/metrics/knowledge; this node binds its own id and
 * registers node-local calculators over sources only this node owns.
 */
import type { MetricCalculator } from "@cogni-dao/metrics/contracts";
import {
	createGoalMetrics as createPublishedGoalMetrics,
	createGoalProgressReader,
	createGoalSource,
} from "@cogni-dao/metrics/knowledge";
import type { Sql } from "postgres";
import { z } from "zod";
import {
	RUN_CALLER_CLASSES,
	readRunsByCaller,
} from "@/adapters/server/metrics/runs.source";
import { getNodeId } from "@/shared/config";

export { createGoalProgressReader, createGoalSource };

const runsParams = z.strictObject({
	class: z.enum(RUN_CALLER_CLASSES),
	mode: z.enum(["count", "share"]),
	days: z.number().int().min(1).max(28),
});

/**
 * Node-local calculator over this node's own graph_runs ledger.
 * Design: https://node-template.cognidao.org/knowledge/usage-metrics-design
 */
function createRunsCountCalculator(observationsSql: Sql): MetricCalculator {
	return {
		id: "runs.count@1",
		// Window edges are started_at event times inside [end - days, end).
		historicalWindows: true,
		unit: "runs",
		unitFor: (params) =>
			runsParams.parse(params).mode === "share" ? "ratio" : "runs",
		display: "volume",
		displayFor: (params) =>
			runsParams.parse(params).mode === "share" ? "progress" : "volume",
		windowSeconds: (params) => runsParams.parse(params).days * 86400,
		paramsSchema: runsParams,
		budget: {
			timeoutMs: 8000,
			maxSourceCalls: 1,
			maxRows: 1,
			maxResponseBytes: 65536,
		},
		compute: async (params, ctx) => {
			const parsed = runsParams.parse(params);
			return ctx.read((signal) =>
				readRunsByCaller(observationsSql, parsed, ctx.window, signal),
			);
		},
	};
}

export function createGoalMetrics(deps: {
	knowledgeSql: Sql;
	observationsSql: Sql;
	environment: string;
	log(event: object): void;
}) {
	return createPublishedGoalMetrics({
		...deps,
		node: getNodeId(),
		nodeCalculators: [createRunsCountCalculator(deps.observationsSql)],
	});
}
