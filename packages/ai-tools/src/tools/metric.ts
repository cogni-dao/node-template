// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Thin node tool bindings over shared contracts. No calculator logic. */
import type { MetricService } from "@cogni-dao/metrics";
import {
	type GoalsProgress,
	GoalsProgressSchema,
	MetricComputeInputSchema,
	MetricError,
	type MetricHistoryInput,
	MetricHistoryInputSchema,
	MetricHistorySchema,
	MetricListInputSchema,
	MetricListResponseSchema,
	MetricObservationSchema,
	MetricSnapshotSchema,
	MetricViewSchema,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
import type { CatalogBoundTool } from "../catalog";
import type {
	ToolContract,
	ToolImplementation,
	ToolRequires,
} from "../types";
/**
 * The node injects its one goal-progress function; history calls the service's
 * historyRange, the same function the HTTP route calls.
 */
export function createMetricTools(
	resolve: () => MetricService | undefined,
	reads?: { goalProgress?: () => Promise<GoalsProgress> },
) {
	const service = () => {
		const value = resolve();
		if (!value) throw new MetricError("metrics_unavailable", 503);
		return value;
	};
	const definitions = [
		{
			name: "core__goal_progress",
			description:
				"Read every active goal with its KPI bindings, one assessment per KPI (status, enum reason, value, target, deadline, display pace), its display type, 30 daily buckets (plus the last 24 hourly buckets for hourly metrics) and hypotheses. Call before triage/planning and after acting. Unknown is never zero.",
			effect: "read_only" as const,
			inputSchema: z.strictObject({}),
			outputSchema: GoalsProgressSchema,
			run: async () => {
				if (!reads?.goalProgress)
					throw new MetricError("goals_unavailable", 503);
				return reads.goalProgress();
			},
		},
		{
			name: "core__metric_history",
			description:
				"Read aligned half-open history buckets for one metric. step is 1h, 1d or 1w; from/to align to the step (1w starts Monday), to <= now, at most 400 buckets. Gaps stay missing; values are never filled.",
			effect: "read_only" as const,
			inputSchema: MetricHistoryInputSchema.extend({ id: z.string().min(1) }),
			outputSchema: MetricHistorySchema,
			run: ({ id, ...range }: MetricHistoryInput & { id: string }) =>
				service().historyRange(id, range),
		},
		{
			name: "core__metric_list",
			description:
				"List configured metrics and available calculators with stored observations and freshness. Pass nextCursor as after to continue. Never invent values.",
			effect: "read_only" as const,
			inputSchema: MetricListInputSchema,
			outputSchema: MetricListResponseSchema,
			run: (p: { limit?: number; after?: string }) =>
				service().list(p.limit, p.after),
		},
		{
			name: "core__metric_read",
			description:
				"Read one metric: latestAttempt, lastGood and viewState together, never a last-good value as current after failure. Pass observationId to inspect one immutable cited observation. Use core__metric_history for ranges.",
			effect: "read_only" as const,
			inputSchema: z.strictObject({
				id: z.string().min(1),
				observationId: z.uuid().optional(),
			}),
			outputSchema: MetricViewSchema.extend({
				observation: MetricObservationSchema.optional(),
				snapshot: MetricSnapshotSchema.optional(),
			}),
			run: async (p: { id: string; observationId?: string }) => {
				const snapshot = p.observationId
					? MetricSnapshotSchema.parse(
							await service().observation(p.id, p.observationId),
						)
					: undefined;
				return {
					...(await service().read(p.id)),
					...(snapshot ? { observation: snapshot.observation, snapshot } : {}),
				};
			},
		},
		{
			name: "core__metric_compute",
			description:
				"Refresh a registered metric through bounded authorized sources. Preserve requestKey when retrying. Does not alter goals or execute scripts.",
			effect: "state_change" as const,
			requires: {
				scope: "metric:compute",
				kind: "node",
				subject: "member",
				label: "Refresh the numbers on your dashboards",
			} as ToolRequires,
			inputSchema: MetricComputeInputSchema.extend({ id: z.string().min(1) }),
			outputSchema: z.object({ observation: MetricObservationSchema }),
			run: async (p: {
				id: string;
				requestKey: string;
				evaluationAt?: string;
			}) => ({ observation: await service().compute(p.id, p) }),
		},
	];
	const tools: CatalogBoundTool[] = [];
	const bindings: Record<string, ToolImplementation<unknown, unknown>> = {};
	for (const d of definitions) {
		const contract: ToolContract<
			string,
			unknown,
			Record<string, unknown>,
			Record<string, unknown>
		> = {
			name: d.name,
			description: d.description,
			effect: d.effect,
			...("requires" in d ? { requires: d.requires } : {}),
			inputSchema: d.inputSchema,
			outputSchema: d.outputSchema,
			allowlist: Object.keys(d.outputSchema.shape),
			redact: (out: Record<string, unknown>) => out,
		};
		const implementation: ToolImplementation<unknown, unknown> = {
			execute: (input) =>
				(d.run as (p: unknown) => Promise<unknown>)(d.inputSchema.parse(input)),
		};
		// Erase heterogeneous validated input/output types at the existing catalog boundary.
		tools.push({ contract, implementation } as unknown as CatalogBoundTool);
		bindings[d.name] = implementation;
	}
	return { tools, bindings };
}

export const METRIC_TOOL_BUNDLE = createMetricTools(() => undefined).tools;
