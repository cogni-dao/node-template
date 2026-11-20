// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/metrics/http` (work expectations)
 * Purpose: The work-item expectations route core every node serves (story.0085): match each EDO hypothesis's KPI bindings to the
 *   item's pinned moves, assess the matched ones in one prediction batch, and return the page the shared item view draws with the
 *   one terminal event.
 * Scope: Framework-free. A node route keeps auth, its item read, its EDO read and its logger; it logs `event` and sends `body`
 *   with `status`. Before story.0085 this logic was a byte-identical app route in every fork.
 * Invariants:
 *   - PINNED_MATCH: a binding is assessed only when a move names its metric and the same baseline observation.
 *   - ONE_BATCH: matched bindings are assessed in one `predictionBatch` call; a failed batch reads `metrics_unavailable`, never an error.
 *   - ONE_TERMINAL_EVENT: every request returns exactly one event with status and code, never the body.
 * Side-effects: none (reads through the node's injected functions)
 * Links: hub work-item-view-capability, ./contracts.ts (WorkExpectationPageSchema)
 * @public
 */

import { type KpiBinding, KpiBindingsSchema, type WorkExpectationPage } from "./contracts.js";
import type { MetricService } from "./index.js";

export const WORK_EXPECTATIONS_READ_EVENT = "work.expectations.read" as const;

export interface WorkExpectationsEvent {
	readonly event: typeof WORK_EXPECTATIONS_READ_EVENT;
	readonly routeId: "work.expectations.get";
	readonly outcome: "success" | "error";
	readonly status: number;
	readonly workItemId: string;
	readonly errorCode?: "not_found" | "unavailable" | "metrics_unavailable";
}

export interface WorkExpectationsResult {
	readonly status: number;
	readonly body: WorkExpectationPage | { readonly error: string };
	readonly event: WorkExpectationsEvent;
}

/** The EDO page a knowledge store returns for one item: hypotheses that name it, with their bindings and outcomes. */
export interface WorkEdoPageLike {
	readonly items: readonly {
		readonly hypothesis: {
			readonly id: string;
			readonly title: string;
			readonly content: string;
			readonly kpiBindings?: unknown;
		};
		readonly outcomes: readonly { readonly id: string; readonly title: string; readonly content: string }[];
		readonly truncated: boolean;
	}[];
	readonly truncated: boolean;
}

/** A move as the item read returns it: the metric and the pinned baseline. */
export interface PinnedMoveLike {
	readonly metricId: string;
	readonly baselineObservationId: string | null;
}

export interface WorkExpectationsDeps {
	readonly workItemId: string;
	/** The node's item read; `null` when no item has the id. */
	readonly readItem: (signal?: AbortSignal) => Promise<{ readonly moves?: readonly PinnedMoveLike[] | undefined } | null>;
	/** The node's EDO read. Absent means the store cannot read EDO: 503 `unavailable`. */
	readonly readEdo?: ((signal?: AbortSignal) => Promise<WorkEdoPageLike>) | undefined;
	/** The node's metric service batch. Absent means no metric readings: each matched prediction reads unavailable. */
	readonly predictionBatch?: MetricService["predictionBatch"] | undefined;
	readonly signal?: AbortSignal;
}

const samePin = (moves: readonly PinnedMoveLike[] | undefined, binding: KpiBinding): boolean =>
	moves?.some(
		(move) =>
			move.metricId === binding.metricId &&
			move.baselineObservationId !== null &&
			move.baselineObservationId === binding.baselineObservationId,
	) ?? false;

/** GET /work/items/{id}/expectations: read the item and its EDO together, assess pinned bindings, and the one terminal event. */
export async function handleWorkExpectations(deps: WorkExpectationsDeps): Promise<WorkExpectationsResult> {
	const reply = (
		status: number,
		body: WorkExpectationsResult["body"],
		errorCode?: WorkExpectationsEvent["errorCode"],
	): WorkExpectationsResult => ({
		status,
		body,
		event: {
			event: WORK_EXPECTATIONS_READ_EVENT,
			routeId: "work.expectations.get",
			outcome: status < 400 && !errorCode ? "success" : "error",
			status,
			workItemId: deps.workItemId,
			...(errorCode ? { errorCode } : {}),
		},
	});
	if (!deps.readEdo) return reply(503, { error: "unavailable" }, "unavailable");
	const [itemResult, pageResult] = await Promise.allSettled([deps.readItem(deps.signal), deps.readEdo(deps.signal)]);
	if (itemResult.status !== "fulfilled" || pageResult.status !== "fulfilled")
		return reply(503, { error: "unavailable" }, "unavailable");
	const item = itemResult.value;
	const page = pageResult.value;
	if (!item) return reply(404, { error: "not found" }, "not_found");

	const entries = page.items.map(({ hypothesis, outcomes, truncated }) => ({
		hypothesis,
		outcomes,
		truncated,
		parsed: KpiBindingsSchema.safeParse(hypothesis.kpiBindings ?? []),
	}));
	const matched = entries.flatMap((entry) =>
		entry.parsed.success ? entry.parsed.data.filter((binding) => samePin(item.moves, binding)) : [],
	);
	let evidenceUnavailable = matched.length > 0 && !deps.predictionBatch;
	const assessments =
		deps.predictionBatch && matched.length
			? await deps.predictionBatch(matched, deps.signal).catch(() => {
					evidenceUnavailable = true;
					return [];
				})
			: [];
	if (assessments.length !== matched.length) evidenceUnavailable = true;

	let cursor = 0;
	const items = entries.map(({ hypothesis, outcomes, truncated, parsed }) => ({
		id: hypothesis.id,
		title: hypothesis.title,
		content: hypothesis.content,
		outcomes: outcomes.map(({ id, title, content }) => ({ id, title, content })),
		truncated,
		predictions: parsed.success
			? parsed.data.map((binding) => {
					const same = samePin(item.moves, binding);
					const result = same ? assessments[cursor++] : undefined;
					const assessment = result?.assessment;
					if (
						same &&
						(!assessment || result?.viewState === "error" || assessment.reason === "metric_authority_unavailable")
					)
						evidenceUnavailable = true;
					const observed = assessment
						? [
								assessment.status,
								assessment.value == null ? null : `${assessment.value} ${assessment.unit}`,
								assessment.observationId,
								assessment.reason,
								assessment.deadline,
								result?.viewState,
							]
								.filter(Boolean)
								.join(" · ")
						: "unavailable (metrics_unavailable)";
					return {
						metricId: binding.metricId,
						expected: `${binding.comparator} ${binding.target.value} ${binding.target.unit}`,
						observed: same ? observed : "unresolved (metric or baseline mismatch)",
					};
				})
			: [{ metricId: "", expected: "invalid binding", observed: "unresolved" }],
	}));
	return reply(200, { items, truncated: page.truncated }, evidenceUnavailable ? "metrics_unavailable" : undefined);
}
