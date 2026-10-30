// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Shared measurement mechanism; no node wiring or source clients. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	type KpiBinding,
	type MetricAction,
	type MetricCalculator,
	type MetricDefinition,
	type MetricDefinitionsPort,
	MetricError,
	type MetricObservation,
	type MetricObservationsPort,
	type MetricScope,
	MetricSpecSchema,
	type MetricView,
} from "./contracts.js";

export * from "./contracts.js";

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
export function metricDefinitionHash(definition: MetricDefinition): string {
	return hashMetric({
		id: definition.id,
		revision: definition.revision,
		spec: definition.spec,
	});
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
			const initial: MetricObservation = {
				id: randomUUID(),
				metricId,
				definitionRevision: definition.revision,
				definitionHash: metricDefinitionHash(definition),
				calculatorVersion: calculator.id,
				paramsHash: hashMetric(definition.spec.params),
				...scope,
				window: { start: end, end },
				...(trigger ? { scheduledFor: trigger.scheduledFor } : {}),
				sourceWatermarks: [],
				observedAt: null,
				status: "pending",
				value: null,
				unit: calculator.unit,
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
					sample.unit === c.unit &&
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
					reason: valid ? null : "incomplete_or_invalid_source",
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
			return { items, nextCursor: page.nextCursor };
		},
		async bindings(bindings: KpiBinding[], options?: { hypothesis?: boolean }) {
			const results = [];
			for (const b of bindings) {
				const empty = {
					...b,
					baseline: null,
					observation: null,
					viewState: "unavailable" as const,
					met: null as boolean | null,
					reason: "metric_unavailable" as string | null,
				};
				if (
					options?.hypothesis &&
					(!b.evaluationAt || !b.baselineObservationId)
				) {
					results.push({
						...empty,
						reason: "fixed_prediction_and_baseline_required",
					});
					continue;
				}
				try {
					const current = await definitionFor(b.metricId, "read");
					const pinned = b.baselineObservationId
						? await observations.snapshot(b.baselineObservationId)
						: null;
					const evidenceDefinition =
						b.evaluationAt && pinned ? pinned.definition : current;
					if (pinned) await authorize("read", pinned.definition);
					const view = selectMetricView(
						evidenceDefinition,
						await observations.history(
							b.metricId,
							metricDefinitionHash(evidenceDefinition),
							1,
						),
						now(),
					);
					if (b.evaluationAt && Date.parse(b.evaluationAt) > now().getTime()) {
						results.push({ ...empty, reason: "evaluation_not_due" });
						continue;
					}
					const fixed = b.evaluationAt
						? await observations.at(
								b.metricId,
								metricDefinitionHash(view.definition),
								b.evaluationAt,
							)
						: view.latestAttempt;
					const baseline = pinned?.observation ?? null;
					const baselineValid =
						!b.baselineObservationId ||
						(!!baseline &&
							baseline.status === "ok" &&
							baseline.metricId === b.metricId &&
							baseline.dataScope === scope.dataScope &&
							baseline.node === scope.node &&
							baseline.environment === scope.environment &&
							baseline.definitionHash ===
								metricDefinitionHash(view.definition) &&
							baseline.unit === b.target.unit &&
							(!b.evaluationAt || baseline.window.end <= b.evaluationAt));
					const evaluationTime = b.evaluationAt
						? Date.parse(b.evaluationAt)
						: now().getTime();
					const selected = selectMetricView(
						view.definition,
						fixed ? [fixed] : [],
						new Date(evaluationTime),
					);
					const fresh = selected.viewState === "ok";
					const ready =
						baselineValid &&
						fresh &&
						fixed?.status === "ok" &&
						fixed.unit === b.target.unit &&
						fixed.value !== null;
					results.push({
						...b,
						baseline: baselineValid ? baseline : null,
						observation: fixed,
						viewState: selected.viewState,
						reason: !baselineValid
							? "baseline_unavailable_or_incompatible"
							: null,
						met:
							ready && fixed?.value != null
								? b.comparator === "gte"
									? fixed.value >= b.target.value
									: b.comparator === "lte"
										? fixed.value <= b.target.value
										: fixed.value === b.target.value
								: null,
					});
				} catch (error) {
					results.push({
						...empty,
						reason:
							error instanceof MetricError && error.status === 503
								? "metric_authority_unavailable"
								: "metric_unavailable",
					});
				}
			}
			return results;
		},
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
						try {
							results.push(
								await service.compute(
									d.id,
									{ requestKey: `scheduled/${hash}/${at}/${attempt}` },
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
