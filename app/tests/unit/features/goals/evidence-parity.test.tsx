// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { createMetricTools } from "@cogni-dao/ai-tools";
import type { MetricService } from "@cogni-dao/metrics";
import type { MetricSnapshot, MetricView } from "@cogni-dao/metrics/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GoalsProgress } from "@/features/goals/components/GoalsProgress";
import type { GoalsProgressData } from "@/features/goals/types";

const saved: MetricSnapshot = {
	definition: {
		id: "work",
		title: "Work",
		revision: "1",
		spec: {
			calculatorId: "work.count@1",
			params: { state: "open" },
			maxAgeSeconds: 60,
		},
	},
	observation: {
		id: "00000000-0000-4000-8000-000000000001",
		metricId: "work",
		definitionRevision: "1",
		definitionHash: "hash1",
		calculatorVersion: "work.count@1",
		paramsHash: "params1",
		node: "test",
		environment: "test",
		dataScope: "test",
		window: { start: "2026-11-02T00:00:00Z", end: "2026-11-02T00:00:00Z" },
		status: "ok",
		observedAt: "2026-11-02T00:00:00Z",
		value: 5,
		unit: "items",
		reason: null,
		sourceWatermarks: [{ source: "work", asOf: "2026-11-02T00:00:00Z" }],
		evidenceRefs: ["node:work"],
	},
};
const later = {
	...saved.observation,
	id: "00000000-0000-4000-8000-000000000002",
	value: 20,
};
const view: MetricView = {
	definition: saved.definition,
	latestAttempt: later,
	lastGood: later,
	viewState: "ok",
};
const binding = {
	metricId: "work",
	comparator: "gte" as const,
	target: { value: 10, unit: "items" },
	evaluationAt: "2026-11-02T00:00:00Z",
};

describe("fixed metric evidence parity", () => {
	it("renders the deadline value and link despite a later successful rolling value", () => {
		const data: GoalsProgressData = {
			asOf: "2026-11-02T01:00:00Z",
			environment: "test",
			goals: [
				{
					id: "goal-work",
					title: "Work",
					evaluateAt: binding.evaluationAt,
					configurationError: false,
					metrics: [
						{
							binding,
							reading: {
								...binding,
								baseline: null,
								observation: saved.observation,
								viewState: "ok",
								met: false,
								reason: null,
							},
							view,
							history: [later, saved.observation],
						},
					],
					hypotheses: [],
					moreHypotheses: false,
					hypothesesUnavailable: false,
				},
			],
		};
		const client = new QueryClient();
		try {
			const html = renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<GoalsProgress initialData={data} />
				</QueryClientProvider>,
			);
			expect(html).toContain("5 items");
			expect(html).not.toContain("20 items");
			expect(html).not.toContain("At target");
			expect(html).toContain(`?observation=${saved.observation.id}`);
			expect(html).not.toContain(`?observation=${later.id}`);
			expect(html).toContain("Ongoing measurements");
		} finally {
			client.clear();
		}
	});

	it("keeps historical calculator parameters distinct from the current tool view", async () => {
		const current = {
			...saved.definition,
			revision: "2",
			spec: { ...saved.definition.spec, params: { state: "validated" } },
		};
		const service = {
			read: vi
				.fn<MetricService["read"]>()
				.mockResolvedValue({ ...view, definition: current }),
			history: vi.fn<MetricService["history"]>().mockResolvedValue([]),
			observation: vi
				.fn<MetricService["observation"]>()
				.mockResolvedValue(saved),
		} satisfies Pick<MetricService, "read" | "history" | "observation">;
		const { tools, bindings } = createMetricTools(
			() => service as MetricService,
		);
		const tool = tools.find((t) => t.contract.name === "core__metric_read");
		if (!tool || !bindings.core__metric_read)
			throw new Error("metric read tool missing");
		const raw = await bindings.core__metric_read.execute({
			id: "work",
			observationId: saved.observation.id,
		});
		const output = tool.contract.outputSchema.parse(raw);
		expect(output).toMatchObject({
			definition: current,
			observation: saved.observation,
			snapshot: saved,
		});
		// Exercise the public output filter so new envelope fields cannot disappear.
		const filtered = Object.fromEntries(
			Object.entries(output).filter(([key]) =>
				tool.contract.allowlist.includes(key),
			),
		);
		expect(filtered).toEqual(output);
		expect(service.observation).toHaveBeenCalledWith(
			"work",
			saved.observation.id,
		);
	});
});
