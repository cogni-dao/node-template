// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Node composition. The calculators, budgets and source allow-list are
 * published in @cogni-dao/metrics/knowledge; this node binds its own id.
 */
import {
	createGoalMetrics as createPublishedGoalMetrics,
	createGoalProgressReader,
	createGoalSource,
} from "@cogni-dao/metrics/knowledge";
import type { Sql } from "postgres";
import { getNodeId } from "@/shared/config";

export { createGoalProgressReader, createGoalSource };

export function createGoalMetrics(deps: {
	knowledgeSql: Sql;
	observationsSql: Sql;
	environment: string;
	log(event: object): void;
}) {
	return createPublishedGoalMetrics({ ...deps, node: getNodeId() });
}
