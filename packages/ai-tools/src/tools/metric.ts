import type { MetricService } from "@cogni-dao/metrics";
import {
	MetricComputeInputSchema,
	MetricError,
	MetricObservationSchema,
	MetricViewSchema,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Thin node tool bindings over shared contracts. No calculator logic. */
import type { CatalogBoundTool } from "../catalog";
import type { ToolContract, ToolImplementation } from "../types";
export function createMetricTools(resolve: () => MetricService | undefined) {
	const service = () => {
		const value = resolve();
		if (!value) throw new MetricError("metrics_unavailable", 503);
		return value;
	};
	const definitions = [
		{
			name: "core__metric_list",
			description:
				"List configured metrics with stored observations, freshness and missing evidence. Never invent values.",
			effect: "read_only" as const,
			inputSchema: z.strictObject({}),
			outputSchema: z.object({
				items: z.array(MetricViewSchema),
				nextCursor: z.string().nullable(),
			}),
			run: () => service().list(),
		},
		{
			name: "core__metric_read",
			description:
				"Read one metric and its immutable observation history. Shared with the KPI page and goal evidence.",
			effect: "read_only" as const,
			inputSchema: z.strictObject({
				id: z.string().min(1),
				observationId: z.uuid().optional(),
			}),
			outputSchema: MetricViewSchema.extend({
				history: z.array(MetricObservationSchema),
				observation: MetricObservationSchema.optional(),
			}),
			run: async (p: { id: string; observationId?: string }) => ({
				...(await service().read(p.id)),
				history: await service().history(p.id),
				...(p.observationId
					? {
							observation: (await service().observation(p.id, p.observationId))
								.observation,
						}
					: {}),
			}),
		},
		{
			name: "core__metric_compute",
			description:
				"Refresh a registered metric through bounded authorized sources. Preserve requestKey when retrying. Does not alter goals or execute scripts.",
			effect: "state_change" as const,
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
			inputSchema: d.inputSchema,
			outputSchema: d.outputSchema,
			allowlist: [
				"items",
				"nextCursor",
				"definition",
				"latestAttempt",
				"lastGood",
				"viewState",
				"history",
				"observation",
			],
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
