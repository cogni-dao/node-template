// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Node composition uses shared tool contracts and implementations. */
import { createMetricTools } from "@cogni/ai-tools";
import type { GoalsProgress, MetricService } from "@cogni-dao/metrics";

/** Inject the node's one goal-progress reader so the route and tool share it. */
export function createGoalMetricTools(deps: {
	metrics: () => MetricService | undefined;
	goalProgress: () => Promise<GoalsProgress>;
}) {
	return createMetricTools(deps.metrics, { goalProgress: deps.goalProgress });
}
