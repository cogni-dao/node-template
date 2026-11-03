// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Shared measurement mechanism; no node wiring or source clients. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	assessKpi,
	floorTo,
	type KpiAssessmentInput,
	metricHistoryRange,
} from "./assess.js";
import {
	type KpiAssessment,
	type KpiBinding,
	type KpiReason,
	type MetricAction,
	type MetricCalculator,
	type MetricDefinition,
	type MetricDefinitionsPort,
	MetricError,
	type MetricHistory,
	type MetricHistoryInput,
	type MetricObservation,
	type MetricObservationsPort,
	type MetricScope,
	MetricSpecSchema,
	type MetricView,
} from "./contracts.js";

export * from "./assess.js";
export * from "./contracts.js";
export * from "./progress.js";

const DAY_MS = 86_400_000;
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function hashMetric(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
/** Series key: id + spec. Revision is provenance only, so title/body edits keep the series. */
export function metricDefinitionHash(definition: MetricDefinition): string {
	return hashMetric({ id: definition.id, spec: definition.spec });
}
/** Unit and interval width of one parameterized calculator. */
export function calculatorShape(
	calculator: MetricCalculator,
	params: unknown,
): { unit: string; windowSeconds: number } {
	return {
		unit: calculator.unitFor?.(params) ?? calculator.unit,
		windowSeconds: calculator.windowSeconds?.(params) ?? 0,
	};
}
export interface GoalKpiResult {
	binding: KpiBinding;
	metric: {
		id: string;
		title: string;
		calculatorId: string;
		cadenceSeconds: number | null;
		maxAgeSeconds: number;
	} | null;
	assessment: KpiAssessment;
	trend: MetricHistory | null;
	baseline: MetricObservation | null;
	/** Evidence the legacy reading names: evaluation reading after the deadline, else latest attempt. */
	observation: MetricObservation | null;
	viewState: MetricView["viewState"];
}
export class MetricRegistry {
	private readonly entries = new Map<string, MetricCalculator>();
	register(calculator: MetricCalculator): void {
		if (this.entries.has(calculator.id))
			throw new MetricError("duplicate_calculator", 422);
		this.entries.set(calculator.id, calculator);
	}
	get(id: string): MetricCalculator {
		const c = this.entries.get(id);
		if (!c) throw new MetricError("unknown_calculator", 422);
		return c;
	}
	validate(d: MetricDefinition): void {
		const s = MetricSpecSchema.parse(d.spec);
		this.get(s.calculatorId).paramsSchema.parse(s.params);
	}
	describe() {
		return [...this.entries.values()].map((c) => ({
			id: c.id,
			unit: c.unit,
			limits: c.budget,
			paramsSchema: z.toJSONSchema(c.paramsSchema),
		}));
	}
}
/** Keep the failed latest attempt visible even while a last-good reading is fresh. */
export function selectMetricView(
	definition: MetricDefinition,
	history: MetricObservation[],
	now: Date,
): MetricView {
	const latestAttempt = history[0] ?? null;
	const lastGood = history.find((x) => x.status === "ok") ?? null;
	const viewState: MetricView["viewState"] =
		latestAttempt?.status === "ok" &&
		(!latestAttempt.sourceWatermarks.length ||
			latestAttempt.sourceWatermarks.some(
				(w) =>
					!w.asOf ||
					!Number.isFinite(Date.parse(w.asOf)) ||
					Date.parse(w.asOf) > now.getTime() ||
					now.getTime() - Date.parse(w.asOf) >
						definition.spec.maxAgeSeconds * 1000,
			))
			? "stale"
			: (latestAttempt?.status ?? "unavailable");
	return { definition, latestAttempt, lastGood, viewState };
}
export function createMetricService(deps: {
	definitions: MetricDefinitionsPort;
	observations: MetricObservationsPort;
	registry: MetricRegistry;
	scope: MetricScope;
	now(): Date;
	authorize(
		action: MetricAction,
		definition: MetricDefinition,
	): Promise<boolean>;
	log?(event: {
		metricId: string;
		observationId: string;
		status: string;
		durationMs: number;
	}): void;
}) {
	const { definitions, observations, registry, now, scope } = deps;
	async function authorize(action: MetricAction, definition: MetricDefinition) {
		let allowed: boolean;
		try {
			allowed = await deps.authorize(action, definition);
		} catch {
			throw new MetricError("metric_authority_unavailable", 503);
		}
		if (!allowed) throw new MetricError("metric_not_found", 404);
	}
	async function definitionFor(id: string, action: MetricAction) {
		const d = await definitions.get(id);
		if (!d) throw new MetricError("metric_not_found", 404);
		await authorize(action, d);
		return d;
	}
	async function series(
		id: string,
		hash: string,
		unit: string,
		input: MetricHistoryInput,
		allowOpenBucket: boolean,
	): Promise<MetricHistory> {
		const range = metricHistoryRange(input, now(), { allowOpenBucket });
		const buckets = await observations.buckets(id, hash, {
			from: range.from,
			to: range.to,
			step: range.step,
		});
		if (buckets.length !== range.starts.length)
			throw new MetricError("history_unavailable", 503);
		return {
			metricId: id,
			unit,
			step: range.step,
			from: range.from,
			to: range.to,
			buckets,
		};
	}
	const service = {
		registry,
		async compute(
			metricId: string,
			input: { requestKey: string; evaluationAt?: string | undefined },
			trigger?: { scheduledFor: string },
		): Promise<MetricObservation> {
			const definition = await definitionFor(metricId, "compute");
			registry.validate(definition);
			const requestHash = hashMetric({
				metricId,
				evaluationAt: input.evaluationAt ?? null,
			});
			const previous = await observations.request(
				metricId,
				input.requestKey,
				requestHash,
			);
			if (previous) {
				await authorize("compute", previous.definition);
				if (previous.observation.status === "pending") {
					// An existing request owns its original attempt. Resolve its
					// active/expired lease before validating a NEW snapshot time.
					const replay = await observations.reserve({
						requestKey: input.requestKey,
						requestHash,
						snapshot: previous,
						leaseMs:
							registry.get(previous.definition.spec.calculatorId).budget
								.timeoutMs + 2000,
					});
					return replay.snapshot.observation;
				}
				return previous.observation;
			}
			const start = now();
			const end = input.evaluationAt ?? start.toISOString();
			if (
				!Number.isFinite(Date.parse(end)) ||
				Date.parse(end) > start.getTime()
			)
				throw new MetricError("invalid_evaluation_time", 400);
			const calculator = registry.get(definition.spec.calculatorId);
			if (
				input.evaluationAt &&
				!calculator.historicalWindows &&
				start.getTime() - Date.parse(input.evaluationAt) > 1000
			)
				throw new MetricError("historical_window_not_supported", 422);
			const shape = calculatorShape(calculator, definition.spec.params);
			const initial: MetricObservation = {
				id: randomUUID(),
				metricId,
				definitionRevision: definition.revision,
				definitionHash: metricDefinitionHash(definition),
				calculatorVersion: calculator.id,
				paramsHash: hashMetric(definition.spec.params),
				...scope,
				window: {
					start: new Date(
						Date.parse(end) - shape.windowSeconds * 1000,
					).toISOString(),
					end: new Date(Date.parse(end)).toISOString(),
				},
				...(trigger ? { scheduledFor: trigger.scheduledFor } : {}),
				sourceWatermarks: [],
				observedAt: null,
				status: "pending",
				value: null,
				unit: shape.unit,
				reason: null,
				evidenceRefs: [],
			};
			const reserved = await observations.reserve({
				requestKey: input.requestKey,
				requestHash,
				snapshot: { definition, observation: initial },
				leaseMs: calculator.budget.timeoutMs + 2000,
			});
			await authorize("compute", reserved.snapshot.definition);
			if (!reserved.leaseToken) return reserved.snapshot.observation;
			const c = registry.get(reserved.snapshot.definition.spec.calculatorId);
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let calls = 0;
			let result = { ...reserved.snapshot.observation };
			try {
				const sample = await Promise.race([
					c.compute(
						c.paramsSchema.parse(reserved.snapshot.definition.spec.params),
						{
							window: result.window,
							signal: controller.signal,
							budget: c.budget,
							async read(source) {
								controller.signal.throwIfAborted();
								if (++calls > c.budget.maxSourceCalls)
									throw new MetricError("source_call_budget", 422);
								return source(controller.signal, c.budget);
							},
						},
					),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							controller.abort();
							reject(new Error("source_timeout"));
						}, c.budget.timeoutMs);
					}),
				]);
				const valid =
					sample.complete &&
					Number.isFinite(sample.value) &&
					sample.unit === result.unit &&
					sample.sourceWatermarks.length > 0 &&
					sample.sourceWatermarks.every(
						(w) =>
							w.asOf !== null &&
							Number.isFinite(Date.parse(w.asOf)) &&
							Date.parse(w.asOf) <= now().getTime(),
					);
				result = {
					...result,
					status: valid ? "ok" : "unavailable",
					value: valid ? sample.value : null,
					sourceWatermarks: sample.sourceWatermarks,
					evidenceRefs: sample.evidenceRefs,
					observedAt: now().toISOString(),
					reason: valid
						? null
						: (sample.reason ?? "incomplete_or_invalid_source"),
				};
			} catch {
				result = {
					...result,
					status: "error",
					observedAt: now().toISOString(),
					reason: controller.signal.aborted
						? "source_timeout"
						: "source_failed",
				};
			} finally {
				if (timer) clearTimeout(timer);
				controller.abort();
			}
			// Authority may change while I/O runs. Denied results are never published.
			await authorize("compute", reserved.snapshot.definition);
			const saved = await observations.complete(
				result.id,
				reserved.leaseToken,
				result,
			);
			if (!saved) throw new MetricError("observation_lease_expired", 409);
			deps.log?.({
				metricId,
				observationId: saved.id,
				status: saved.status,
				durationMs: now().getTime() - start.getTime(),
			});
			return saved;
		},
		async read(id: string): Promise<MetricView> {
			const d = await definitionFor(id, "read");
			const hash = metricDefinitionHash(d);
			const view = selectMetricView(
				d,
				await observations.history(id, hash, 1),
				now(),
			);
			view.lastGood = await observations.lastGood(id, hash);
			return view;
		},
		async history(id: string) {
			const d = await definitionFor(id, "read");
			return observations.history(id, metricDefinitionHash(d), 50);
		},
		async observation(id: string, observationId: string) {
			await definitionFor(id, "read");
			const saved = await observations.snapshot(observationId);
			const r = saved?.observation;
			if (
				!saved ||
				!r ||
				saved.definition.id !== id ||
				r.metricId !== id ||
				r.node !== scope.node ||
				r.environment !== scope.environment ||
				r.dataScope !== scope.dataScope ||
				r.definitionHash !== metricDefinitionHash(saved.definition)
			)
				throw new MetricError("observation_not_found", 404);
			// Definition edits must neither erase evidence nor bypass revoked
			// access to the connection that produced that historical evidence.
			await authorize("read", saved.definition);
			return saved;
		},
		async list(limit = 50, after?: string) {
			const page = await definitions.list(Math.min(50, limit), after);
			const items: MetricView[] = [];
			for (const d of page.items) {
				try {
					items.push(await service.read(d.id));
				} catch (e) {
					if (!(e instanceof MetricError) || e.status !== 404) throw e;
				}
			}
			return {
				items,
				nextCursor: page.nextCursor,
				catalog: registry.describe(),
			};
		},
		/**
		 * One KPI read: binding → metric summary, assessKpi result and a 30-day
		 * daily trend. Live goal KPIs never select fixed observations; only a
		 * deadline that has passed selects the backward-final evaluation reading.
		 */
		async kpi(
			b: KpiBinding,
			options?: { deadline?: string | null; hypothesis?: boolean },
		): Promise<GoalKpiResult> {
			const at = now();
			const deadline = b.evaluationAt ?? options?.deadline ?? null;
			const empty: Omit<KpiAssessmentInput, "binding" | "metric"> = {
				latestAttempt: null,
				lastGood: null,
				viewState: "unavailable",
				deadline,
				evaluation: null,
				firstGood: null,
				daily: [],
				now: at,
			};
			const unmeasured = (
				reason: KpiReason,
				metric: GoalKpiResult["metric"] = null,
			): GoalKpiResult => ({
				binding: b,
				metric,
				assessment: assessKpi({
					...empty,
					binding: b,
					metric: null,
					unavailable: reason,
				}),
				trend: null,
				baseline: null,
				observation: null,
				viewState: "unavailable",
			});
			if (options?.hypothesis && (!b.evaluationAt || !b.baselineObservationId))
				return unmeasured("fixed_prediction_and_baseline_required");
			let current: MetricDefinition;
			let pinned: Awaited<ReturnType<MetricObservationsPort["snapshot"]>>;
			try {
				current = await definitionFor(b.metricId, "read");
				pinned = b.baselineObservationId
					? await observations.snapshot(b.baselineObservationId)
					: null;
				if (pinned) await authorize("read", pinned.definition);
			} catch (error) {
				return unmeasured(
					error instanceof MetricError && error.status === 503
						? "metric_authority_unavailable"
						: "metric_unavailable",
				);
			}
			// A fixed prediction keeps the definition its baseline measured.
			const definition = b.evaluationAt && pinned ? pinned.definition : current;
			const summary = {
				id: current.id,
				title: current.title,
				calculatorId: definition.spec.calculatorId,
				cadenceSeconds: definition.spec.cadenceSeconds ?? null,
				maxAgeSeconds: definition.spec.maxAgeSeconds,
			};
			let shape: ReturnType<typeof calculatorShape>;
			try {
				shape = calculatorShape(
					registry.get(definition.spec.calculatorId),
					definition.spec.params,
				);
			} catch {
				return unmeasured("calculator_unavailable", summary);
			}
			const hash = metricDefinitionHash(definition);
			const baseline = pinned?.observation ?? null;
			if (
				b.baselineObservationId &&
				!(
					baseline &&
					baseline.status === "ok" &&
					baseline.metricId === b.metricId &&
					baseline.dataScope === scope.dataScope &&
					baseline.node === scope.node &&
					baseline.environment === scope.environment &&
					baseline.definitionHash === hash &&
					baseline.unit === b.target.unit &&
					(!b.evaluationAt ||
						Date.parse(baseline.window.end) <= Date.parse(b.evaluationAt))
				)
			)
				return unmeasured("baseline_unavailable_or_incompatible", summary);
			const [latest] = await observations.history(b.metricId, hash, 1);
			const view = selectMetricView(definition, latest ? [latest] : [], at);
			const lastGood = await observations.lastGood(b.metricId, hash);
			const firstGood = await observations.firstGood(b.metricId, hash);
			const due = deadline !== null && Date.parse(deadline) <= at.getTime();
			const evaluation = due
				? await observations.at(
						b.metricId,
						hash,
						deadline,
						definition.spec.maxAgeSeconds,
					)
				: null;
			let trend: MetricHistory | null = null;
			try {
				trend = await series(
					b.metricId,
					hash,
					shape.unit,
					{
						from: new Date(
							floorTo(at.getTime(), "1d") - 29 * DAY_MS,
						).toISOString(),
						to: new Date(floorTo(at.getTime(), "1d") + DAY_MS).toISOString(),
						step: "1d",
					},
					true,
				);
			} catch {
				trend = null;
			}
			const assessment = assessKpi({
				binding: b,
				metric: {
					unit: shape.unit,
					maxAgeSeconds: definition.spec.maxAgeSeconds,
					windowSeconds: shape.windowSeconds,
				},
				latestAttempt: view.latestAttempt,
				lastGood,
				viewState: view.viewState,
				deadline,
				evaluation,
				firstGood,
				daily: trend?.buckets.slice(-28) ?? [],
				now: at,
			});
			return {
				binding: b,
				metric: summary,
				assessment,
				trend,
				baseline,
				observation: due ? evaluation : view.latestAttempt,
				viewState: view.viewState,
			};
		},
		/** Legacy reading projection over kpi(); met is never null without a reason. */
		async bindings(
			bindings: KpiBinding[],
			options?: { hypothesis?: boolean; deadline?: string | null },
		) {
			const results = [];
			for (const b of bindings) {
				const r = await service.kpi(b, options);
				const status = r.assessment.status;
				const met =
					status === "met" || status === "on_track"
						? true
						: status === "missed" || status === "behind"
							? false
							: null;
				results.push({
					...b,
					baseline: r.baseline,
					observation: r.observation,
					viewState: r.viewState,
					met,
					reason: r.assessment.reason ?? (met === null ? status : null),
					assessment: r.assessment,
				});
			}
			return results;
		},
		/** Ranged history: aligned half-open buckets, same authorization as read. */
		async historyRange(
			id: string,
			input: MetricHistoryInput,
		): Promise<MetricHistory> {
			const d = await definitionFor(id, "read");
			let unit = "";
			try {
				unit = calculatorShape(
					registry.get(d.spec.calculatorId),
					d.spec.params,
				).unit;
			} catch {
				unit = "";
			}
			return series(id, metricDefinitionHash(d), unit, input, false);
		},
		now,
		async refreshDue() {
			const started = now();
			await observations.expireLeases();
			let cursor = await observations.cursor();
			const results: MetricObservation[] = [];
			let scanned = 0;
			let wrapped = false;
			while (scanned < 20 && now().getTime() - started.getTime() < 25000) {
				let page = await definitions.list(1, cursor ?? undefined);
				if (!page.items.length) {
					if (wrapped || !cursor) break;
					cursor = null;
					wrapped = true;
					page = await definitions.list(1);
				}
				const d = page.items[0];
				if (!d) break;
				cursor = d.id;
				scanned++;
				const cadence = d.spec.cadenceSeconds;
				if (cadence) {
					const at = new Date(
						Math.floor(started.getTime() / (cadence * 1000)) * cadence * 1000,
					).toISOString();
					const hash = metricDefinitionHash(d);
					const attempts = await observations.scheduledAttempts(d.id, hash, at);
					const last = attempts[0];
					const succeeded = attempts.some((a) => a.status === "ok");
					const eligible =
						!last ||
						last.status === "pending" ||
						(attempts.length < 4 &&
							now().getTime() -
								Date.parse(last.observedAt ?? last.window.end) >=
								60000 * 2 ** (attempts.length - 1));
					if (!succeeded && eligible) {
						const attempt =
							last?.status === "pending"
								? attempts.length - 1
								: attempts.length;
						// Only interval calculators measure the slot itself. One window
						// keeps one observation, so a retry ends attempt ms after the slot.
						// Snapshot calculators keep measuring now (a backdated snapshot 422s).
						let historical = false;
						try {
							historical = !!registry.get(d.spec.calculatorId)
								.historicalWindows;
						} catch {
							historical = false;
						}
						try {
							results.push(
								await service.compute(
									d.id,
									{
										requestKey: `scheduled/${hash}/${at}/${attempt}`,
										...(historical
											? {
													evaluationAt: new Date(
														Date.parse(at) + attempt,
													).toISOString(),
												}
											: {}),
									},
									{ scheduledFor: at },
								),
							);
						} catch (e) {
							if (
								!(e instanceof MetricError) ||
								![404, 409, 422].includes(e.status)
							)
								throw e;
						}
					}
				}
				await observations.advanceCursor(cursor);
				if (!page.nextCursor) break;
			}
			return { scanned, observations: results };
		},
	};
	return service;
}
export type MetricService = ReturnType<typeof createMetricService>;
