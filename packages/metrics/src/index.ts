// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Shared measurement mechanism; no node wiring or source clients. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	assessKpi,
	floorTo,
	type KpiAssessmentInput,
	metricHistoryRange,
	selectEvaluation,
} from "./assess.js";
import {
	displayFits,
	type EditsSourceTiming,
	type EditsTimingUpdate,
	type KpiAssessment,
	type KpiBinding,
	type KpiReason,
	type MetricAction,
	type MetricCalculator,
	type MetricDefinition,
	type MetricLatest,
	type MetricDefinitionsPort,
	type MetricDisplay,
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

/** Definitions one goal read scans for `serves`; a cut is reported as `truncated`. */
export const SERVES_SCAN_MAX = 200;
/** Definitions one goal read opens at once; reads stay bounded and keep their order. The service pool bounds the real parallelism. */
const SERVING_CONCURRENCY = 8;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
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
		display?: MetricDisplay;
	} | null;
	assessment: KpiAssessment;
	trend: MetricHistory | null;
	recent: MetricHistory | null;
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
/** A view's latest reading for the goal read: newest attempt state, last good value and its time. */
export function metricLatest(view: MetricView): MetricLatest {
	const { latestAttempt: attempt, lastGood: good } = view;
	return {
		viewState: view.viewState,
		value: good?.value ?? null,
		unit: good?.unit ?? attempt?.unit ?? "",
		observedAt: good?.observedAt ?? null,
		reason: attempt && attempt.status !== "ok" ? attempt.reason : null,
	};
}
/** One metric listed by the goal read. */
export interface ServingRow {
	definition: MetricDefinition;
	assessment: KpiAssessment | null;
	latest: MetricLatest;
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
		event: "metric.compute.completed";
		metricId: string;
		observationId: string;
		status: string;
		/** Stable reason code of a failed or unknown reading; null when ok. */
		reason: string | null;
		durationMs: number;
		sourceTiming?: EditsSourceTiming;
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
	/** One definition as the goal read lists it; null when this caller may not read it. */
	async function servingRow(d: MetricDefinition): Promise<ServingRow | null> {
		try {
			await authorize("read", d);
		} catch (e) {
			// A metric this caller may not read is not listed; an authority outage
			// throws, and the goal read reports it as servedUnavailable.
			if (e instanceof MetricError && e.status === 404) return null;
			throw e;
		}
		try {
			const view = await service.viewOf(d);
			return {
				definition: d,
				assessment: view.bandAssessment ?? null,
				latest: metricLatest(view),
			};
		} catch {
			// One unreadable metric reads red; it never drops the whole list (absent is red).
			return {
				definition: d,
				assessment: null,
				latest: {
					viewState: "error",
					value: null,
					unit: "",
					observedAt: null,
					reason: "source_failed",
				},
			};
		}
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
			const isEdits =
				c.id === "no-inline-history@1" &&
				(reserved.snapshot.definition.spec.params as { measure?: string })
					.measure === "edits";
			const stage = () => ({ state: "not_started" as const, durationMs: null });
			const timing: EditsSourceTiming = {
				windowCommits: stage(),
				workDiff: stage(),
				knowledgeDiff: stage(),
				windowCommitCount: null,
				workRows: null,
				workBytes: null,
				knowledgeRows: null,
				knowledgeBytes: null,
			};
			const starts: Partial<
				Record<"windowCommits" | "workDiff" | "knowledgeDiff", number>
			> = {};
			let frozenTiming: EditsSourceTiming | undefined;
			const clock = (): number | null => {
				try {
					const n = performance.now();
					return Number.isFinite(n) ? n : null;
				} catch {
					return null;
				}
			};
			const elapsed = (start: number | undefined, end: number | null) =>
				start !== undefined && end !== null && end >= start
					? end - start
					: null;
			const updateTiming = (update: EditsTimingUpdate) => {
				try {
					if (frozenTiming) return;
					const part = timing[update.stage];
					if (update.phase === "start") {
						part.state = "running";
						const n = clock();
						if (n !== null) starts[update.stage] = n;
					} else if (update.phase === "counts") {
						if (
							!Number.isSafeInteger(update.rows) ||
							update.rows < 0 ||
							(update.bytes !== undefined &&
								(!Number.isSafeInteger(update.bytes) || update.bytes < 0))
						)
							return;
						if (update.stage === "windowCommits")
							timing.windowCommitCount = update.rows;
						else if (update.stage === "workDiff") {
							timing.workRows = update.rows;
							timing.workBytes = update.bytes ?? null;
						} else {
							timing.knowledgeRows = update.rows;
							timing.knowledgeBytes = update.bytes ?? null;
						}
					} else {
						part.state = update.phase;
						part.durationMs = elapsed(starts[update.stage], clock());
					}
				} catch {
					/* diagnostics must not affect the calculator */
				}
			};
			const freezeTiming = () => {
				if (!isEdits || frozenTiming) return;
				const n = clock();
				frozenTiming = {
					...timing,
					windowCommits: { ...timing.windowCommits },
					workDiff: { ...timing.workDiff },
					knowledgeDiff: { ...timing.knowledgeDiff },
				};
				for (const key of [
					"windowCommits",
					"workDiff",
					"knowledgeDiff",
				] as const)
					if (frozenTiming[key].state === "running")
						frozenTiming[key].durationMs = elapsed(starts[key], n);
			};
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
							editsTiming: isEdits ? updateTiming : undefined,
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
							freezeTiming();
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
				freezeTiming();
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
				event: "metric.compute.completed",
				metricId,
				observationId: saved.id,
				status: saved.status,
				reason: saved.reason,
				durationMs: now().getTime() - start.getTime(),
				...(frozenTiming ? { sourceTiming: frozenTiming } : {}),
			});
			return saved;
		},
		/** One scoped definition query and one scoped observation query for a work page. */
		/** Fixed EDO commitments share one authorized snapshot and due-evidence read. */
		async predictionBatch(bindings: readonly KpiBinding[]) {
			if (bindings.length > 100) throw new MetricError("too_many_metrics", 400);
			if (!definitions.getMany || !observations.predictionReadBatch)
				throw new MetricError("batch_unavailable", 503);
			const at = now();
			const found = await definitions.getMany([
				...new Set(bindings.map((b) => b.metricId)),
			]);
			const allowed = new Map<string, MetricDefinition>();
			for (const d of found) {
				try {
					await authorize("read", d);
					allowed.set(d.id, d);
				} catch {
					/* denied stays unknown */
				}
			}
			const selected = bindings.filter(
				(b) =>
					allowed.has(b.metricId) && b.baselineObservationId && b.evaluationAt,
			);
			const rows = await observations.predictionReadBatch(
				selected.map((b) => ({
					metricId: b.metricId,
					baselineObservationId: b.baselineObservationId as string,
					evaluationAt: b.evaluationAt as string,
				})),
			);
			if (rows.length !== selected.length)
				throw new MetricError("batch_unavailable", 503);
			let cursor = 0;
			return Promise.all(
				bindings.map(async (binding) => {
					const missing = (reason: KpiReason) => ({
						...binding,
						assessment: assessKpi({
							binding,
							metric: null,
							unavailable: reason,
							latestAttempt: null,
							lastGood: null,
							viewState: "unavailable",
							deadline: binding.evaluationAt ?? null,
							evaluation: null,
							daily: [],
							now: at,
						}),
					});
					if (!allowed.has(binding.metricId))
						return missing("metric_unavailable");
					if (!binding.baselineObservationId || !binding.evaluationAt)
						return missing("fixed_prediction_and_baseline_required");
					const row = rows[cursor++];
					const pinned = row?.baseline;
					if (!pinned) return missing("baseline_unavailable_or_incompatible");
					const def = pinned.definition,
						baseline = pinned.observation,
						hash = metricDefinitionHash(def);
					try {
						await authorize("read", def);
					} catch {
						return missing("metric_unavailable");
					}
					if (
						def.id !== binding.metricId ||
						baseline.id !== binding.baselineObservationId ||
						baseline.metricId !== binding.metricId ||
						baseline.definitionHash !== hash ||
						baseline.node !== scope.node ||
						baseline.environment !== scope.environment ||
						baseline.dataScope !== scope.dataScope ||
						baseline.status !== "ok" ||
						baseline.value === null ||
						!Number.isFinite(baseline.value) ||
						baseline.unit !== binding.target.unit ||
						!Number.isFinite(Date.parse(baseline.window.end)) ||
						Date.parse(baseline.window.end) > Date.parse(binding.evaluationAt)
					)
						return missing("baseline_unavailable_or_incompatible");
					let shape: ReturnType<typeof calculatorShape>;
					try {
						shape = calculatorShape(
							registry.get(def.spec.calculatorId),
							def.spec.params,
						);
					} catch {
						return missing("calculator_unavailable");
					}
					const paramsHash = hashMetric(def.spec.params);
					const compatible = (o: MetricObservation | null | undefined) =>
						o &&
						o.metricId === binding.metricId &&
						o.definitionHash === hash &&
						o.calculatorVersion === def.spec.calculatorId &&
						o.paramsHash === paramsHash &&
						o.unit === shape.unit &&
						Date.parse(o.window.end) - Date.parse(o.window.start) ===
							shape.windowSeconds * 1000 &&
						o.node === scope.node &&
						o.environment === scope.environment &&
						o.dataScope === scope.dataScope
							? o
							: null;
					// A fixed prediction keeps evidence that was fresh at its own
					// observation/evaluation time, even years after the deadline.
					const freshAt = (o: MetricObservation, reference: number) => {
						const observed = Date.parse(o.observedAt ?? "");
						const end = Date.parse(o.window.end);
						const age = def.spec.maxAgeSeconds * 1000;
						const at = Math.max(reference, observed);
						return (
							o.status === "ok" &&
							o.value !== null &&
							Number.isFinite(o.value) &&
							Number.isFinite(at) &&
							observed >= end &&
							at - end <= age &&
							o.sourceWatermarks.length > 0 &&
							o.sourceWatermarks.every(({ asOf }) => {
								const sourceAt = Date.parse(asOf ?? "");
								return sourceAt <= observed && at - sourceAt <= age;
							})
						);
					};
					const deadline = Date.parse(binding.evaluationAt);
					if (
						!compatible(baseline) ||
						!freshAt(baseline, Date.parse(baseline.observedAt ?? "")) ||
						Date.parse(baseline.observedAt ?? "") > deadline
					)
						return missing("baseline_unavailable_or_incompatible");
					const latest = compatible(row?.latest),
						good = compatible(row?.lastGood),
						candidate = compatible(row?.evaluation);
					const evaluation =
						candidate &&
						freshAt(candidate, deadline) &&
						Date.parse(candidate.window.end) >= Date.parse(baseline.window.end)
							? selectEvaluation(
									[candidate],
									binding.evaluationAt,
									def.spec.maxAgeSeconds,
								)
							: null;
					const view = selectMetricView(def, latest ? [latest] : [], at);
					return {
						...binding,
						assessment: assessKpi({
							binding,
							metric: {
								unit: shape.unit,
								maxAgeSeconds: def.spec.maxAgeSeconds,
							},
							latestAttempt: latest,
							lastGood: good,
							viewState: view.viewState,
							deadline: binding.evaluationAt,
							evaluation,
							daily: [],
							now: at,
						}),
					};
				}),
			);
		},
		async workReadBatch(
			requests: readonly {
				metricId: string;
				baselineObservationId: string | null;
			}[],
		) {
			if (requests.length > 300) throw new MetricError("too_many_metrics", 400);
			if (!definitions.getMany || !observations.workReadBatch)
				throw new MetricError("batch_unavailable", 503);
			const found = await definitions.getMany([
				...new Set(requests.map((r) => r.metricId)),
			]);
			const allowed = new Map<string, MetricDefinition>();
			for (const definition of found) {
				try {
					await authorize("read", definition);
					allowed.set(definition.id, definition);
				} catch {
					/* denied stays unknown */
				}
			}
			const selected = requests
				.map((r) => ({ ...r, definition: allowed.get(r.metricId) }))
				.filter(
					(r): r is typeof r & { definition: MetricDefinition } =>
						!!r.definition,
				);
			const rows = await observations.workReadBatch(
				selected.map((r) => ({
					metricId: r.metricId,
					baselineObservationId: r.baselineObservationId,
					definitionHash: metricDefinitionHash(r.definition),
				})),
			);
			if (rows.length !== selected.length)
				throw new MetricError("batch_unavailable", 503);
			let cursor = 0;
			return Promise.all(
				requests.map(
					async (
						request,
					): Promise<{
						baseline: MetricObservation | null;
						current:
							| (MetricObservation & {
									metricTitle: string;
									maxAgeSeconds: number;
									viewState: MetricView["viewState"];
							  })
							| null;
						unknownReason?: "metrics_unavailable" | "metric_deprecated";
					}> => {
						const definition = allowed.get(request.metricId);
						if (!definition)
							return {
								baseline: null,
								current: null,
								unknownReason: found.some((d) => d.id === request.metricId)
									? "metrics_unavailable"
									: "metric_deprecated",
							};
						const row = rows[cursor++];
						let baseline = row?.baseline ?? null;
						if (baseline) {
							const observation = baseline.observation;
							if (
								observation.id !== request.baselineObservationId ||
								observation.metricId !== request.metricId ||
								baseline.definition.id !== request.metricId ||
								observation.node !== scope.node ||
								observation.environment !== scope.environment ||
								observation.dataScope !== scope.dataScope ||
								observation.definitionHash !==
									metricDefinitionHash(baseline.definition)
							)
								baseline = null;
							else {
								try {
									await authorize("read", baseline.definition);
								} catch {
									baseline = null;
								}
							}
						}
						const candidate = row?.latest ?? null;
						const latest =
							candidate &&
							candidate.metricId === request.metricId &&
							candidate.definitionHash === metricDefinitionHash(definition) &&
							candidate.node === scope.node &&
							candidate.environment === scope.environment &&
							candidate.dataScope === scope.dataScope
								? candidate
								: null;
						const view = selectMetricView(
							definition,
							latest ? [latest] : [],
							now(),
						);
						const age = latest
							? now().getTime() - Date.parse(latest.window.end)
							: NaN;
						const current = latest
							? {
									...latest,
									metricTitle: definition.title,
									maxAgeSeconds: definition.spec.maxAgeSeconds,
									viewState:
										view.viewState === "ok" &&
										(!Number.isFinite(age) ||
											age < 0 ||
											age > definition.spec.maxAgeSeconds * 1000)
											? ("stale" as const)
											: view.viewState,
								}
							: null;
						return { baseline: baseline?.observation ?? null, current };
					},
				),
			);
		},
		async read(id: string): Promise<MetricView> {
			return service.viewOf(await definitionFor(id, "read"));
		},
		/** One authorized definition's view: newest attempt, last good reading and band assessment. */
		async viewOf(d: MetricDefinition): Promise<MetricView> {
			const hash = metricDefinitionHash(d);
			const history = await observations.history(d.id, hash, 1);
			const view = selectMetricView(d, history, now());
			view.lastGood = await observations.lastGood(d.id, hash);
			// The band reuses the two reads above: no second definition or reading read.
			const band = await service.bandAssessment(d, {
				latest: history[0],
				lastGood: view.lastGood,
			});
			if (band) view.bandAssessment = band;
			return view;
		},
		/**
		 * A metric's own band, assessed as a synthetic binding through kpi(): the
		 * one assessment path. Latest reading only; null without a band.
		 */
		async bandAssessment(
			d: MetricDefinition,
			preloaded?: {
				latest: MetricObservation | undefined;
				lastGood: MetricObservation | null;
			},
		): Promise<KpiAssessment | null> {
			if (!d.band) return null;
			return (
				await service.kpi(
					{ metricId: d.id, ...d.band },
					{
						latestOnly: true,
						...(preloaded
							? { preloaded: { definition: d, ...preloaded } }
							: {}),
					},
				)
			).assessment;
		},
		/**
		 * Every readable metric with its band assessment and latest reading: those that
		 * declare `serves` (or carry an invalid annex) in `items`, and those with no
		 * valid or invalid `serves` in `unbound`. A bad band may appear in both.
		 * Scans at most SERVES_SCAN_MAX definitions; `truncated` admits a cut. The read
		 * is latest-only: per definition one newest-attempt read and one last-good read
		 * (the band assessment reuses both). No history range read, no second definition read.
		 */
		async serving(): Promise<{
			items: ServingRow[];
			unbound: ServingRow[];
			truncated: boolean;
		}> {
			const items: ServingRow[] = [];
			const unbound: ServingRow[] = [];
			let cursor: string | undefined;
			let scanned = 0;
			let truncated = false;
			while (scanned < SERVES_SCAN_MAX) {
				const page = await definitions.list(50, cursor);
				scanned += page.items.length;
				// A page reads in small concurrent chunks; results keep the page's order.
				for (let i = 0; i < page.items.length; i += SERVING_CONCURRENCY) {
					const rows = await Promise.all(
						page.items.slice(i, i + SERVING_CONCURRENCY).map(servingRow),
					);
					for (const row of rows) {
						if (!row) continue;
						const d = row.definition;
						if (d.serves || d.annexInvalid?.length) items.push(row);
						if (
							!d.serves &&
							!d.annexInvalid?.some((bad) => bad.field === "serves")
						)
							unbound.push(row);
					}
				}
				if (!page.nextCursor) break;
				cursor = page.nextCursor;
				if (scanned >= SERVES_SCAN_MAX) truncated = true;
			}
			return { items, unbound, truncated };
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
		 * One KPI read: binding → metric summary (with its display type),
		 * assessKpi result, a 30-day daily trend and, for hourly-or-faster
		 * metrics, the last 24 hourly buckets. Live goal KPIs never select fixed observations; only a
		 * deadline that has passed selects the backward-final evaluation reading.
		 */
		async kpi(
			b: KpiBinding,
			options?: {
				deadline?: string | null;
				hypothesis?: boolean;
				/** Skip the trend and recent history queries: one bounded latest-reading read. */
				latestOnly?: boolean;
				/**
				 * A definition the caller already authorized and its newest attempt and last
				 * good reading, so this read repeats none of them (the goal read's metric list).
				 */
				preloaded?: {
					definition: MetricDefinition;
					latest: MetricObservation | undefined;
					lastGood: MetricObservation | null;
				};
			},
		): Promise<GoalKpiResult> {
			const at = now();
			const deadline = b.evaluationAt ?? options?.deadline ?? null;
			const empty: Omit<KpiAssessmentInput, "binding" | "metric"> = {
				latestAttempt: null,
				lastGood: null,
				viewState: "unavailable",
				deadline,
				evaluation: null,
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
				recent: null,
				baseline: null,
				observation: null,
				viewState: "unavailable",
			});
			if (options?.hypothesis && (!b.evaluationAt || !b.baselineObservationId))
				return unmeasured("fixed_prediction_and_baseline_required");
			let current: MetricDefinition;
			let pinned: Awaited<ReturnType<MetricObservationsPort["snapshot"]>>;
			try {
				current =
					options?.preloaded?.definition ??
					(await definitionFor(b.metricId, "read"));
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
			let display: MetricDisplay | undefined;
			try {
				const calculator = registry.get(definition.spec.calculatorId);
				shape = calculatorShape(calculator, definition.spec.params);
				const fallback =
					calculator.displayFor?.(definition.spec.params) ?? calculator.display;
				// An override the unit cannot honour (slo needs "%") yields to the default.
				display =
					current.display && displayFits(current.display, shape.unit)
						? current.display
						: fallback;
			} catch {
				return unmeasured("calculator_unavailable", summary);
			}
			const metric = display ? { ...summary, display } : summary;
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
				return unmeasured("baseline_unavailable_or_incompatible", metric);
			const latest = options?.preloaded
				? options.preloaded.latest
				: (await observations.history(b.metricId, hash, 1))[0];
			const view = selectMetricView(definition, latest ? [latest] : [], at);
			const lastGood = options?.preloaded
				? options.preloaded.lastGood
				: await observations.lastGood(b.metricId, hash);
			const due = deadline !== null && Date.parse(deadline) <= at.getTime();
			const evaluation = due
				? await observations.at(
						b.metricId,
						hash,
						deadline,
						definition.spec.maxAgeSeconds,
					)
				: null;
			const dayEnd = floorTo(at.getTime(), "1d") + DAY_MS;
			const trend = options?.latestOnly
				? null
				: await series(
						b.metricId,
						hash,
						shape.unit,
						{
							from: new Date(dayEnd - 30 * DAY_MS).toISOString(),
							to: new Date(dayEnd).toISOString(),
							step: "1d",
						},
						true,
					).catch(() => null);
			// Hourly-or-faster metrics also carry their last day, so a young series has a shape.
			const hourEnd = floorTo(at.getTime(), "1h") + HOUR_MS;
			const recent =
				!options?.latestOnly &&
				(definition.spec.cadenceSeconds ?? Number.POSITIVE_INFINITY) <= 3600
					? await series(
							b.metricId,
							hash,
							shape.unit,
							{
								from: new Date(hourEnd - 24 * HOUR_MS).toISOString(),
								to: new Date(hourEnd).toISOString(),
								step: "1h",
							},
							true,
						).catch(() => null)
					: null;
			const assessment = assessKpi({
				binding: b,
				metric: {
					unit: shape.unit,
					maxAgeSeconds: definition.spec.maxAgeSeconds,
				},
				latestAttempt: view.latestAttempt,
				lastGood,
				viewState: view.viewState,
				deadline,
				evaluation,
				daily: trend?.buckets.slice(-28) ?? [],
				now: at,
			});
			return {
				binding: b,
				metric,
				assessment,
				trend,
				recent,
				baseline,
				observation: due ? evaluation : view.latestAttempt,
				viewState: view.viewState,
			};
		},
		/**
		 * Legacy reading projection over kpi(). With a deadline, `met` comes only
		 * from the final met/missed verdict and is null (evaluation_not_due) before
		 * it; without one it is the live comparison. reason is the enum reason.
		 */
		async bindings(
			bindings: KpiBinding[],
			options?: { hypothesis?: boolean; deadline?: string | null },
		) {
			const results = [];
			for (const b of bindings) {
				const r = await service.kpi(b, options);
				const { status } = r.assessment;
				const deadline = b.evaluationAt ?? options?.deadline ?? null;
				const due =
					deadline !== null && Date.parse(deadline) <= now().getTime();
				const met = deadline
					? status === "met"
						? true
						: status === "missed"
							? false
							: null
					: status === "on_track"
						? true
						: status === "behind" || r.assessment.reason === "target_breached"
							? false
							: null;
				results.push({
					...b,
					baseline: r.baseline,
					observation: r.observation,
					viewState: r.viewState,
					met,
					reason:
						r.assessment.reason ??
						(deadline && !due && r.assessment.status !== "not_measured"
							? ("evaluation_not_due" as const)
							: null),
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
