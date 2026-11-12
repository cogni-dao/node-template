// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Measurement contracts. Nodes supply sources, authority and persistence.
 * Invariants: HASH_COVERS_SPEC_ONLY (the series hash covers `{id, spec}`;
 * `display`, `serves` and `band` are stored beside the spec and never enter
 * it); ANNEX_NOT_CORE (an invalid `serves` or `band` is ignored and reported,
 * never dropping a metric whose core spec is valid); ONE_ASSESSMENT (a `band` is assessed as a synthetic binding
 * `{metricId, ...band}` through the KPI path, never a second algorithm).
 */
import { z } from "zod";
export const MetricSpecSchema = z.strictObject({
	calculatorId: z.string().regex(/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/),
	params: z.record(z.string(), z.unknown()),
	cadenceSeconds: z
		.number()
		.int()
		.min(60)
		.max(86400 * 365)
		.refine((n) => n % 60 === 0)
		.optional(),
	maxAgeSeconds: z.number().int().positive(),
});
export type MetricSpec = z.infer<typeof MetricSpecSchema>;
/**
 * How a metric reads best. progress: a value against a target. volume: an
 * amount that grows (stars, revenue, counts). slo: a percentage (unit "%") read
 * as availability against a ≥ or ≤ objective with an error budget. The
 * calculator declares a default; a metric definition may override it.
 */
export const MetricDisplaySchema = z.enum(["progress", "slo", "volume"]);
export type MetricDisplay = z.infer<typeof MetricDisplaySchema>;
/** The only unit an slo display reads correctly. */
export const SLO_UNIT = "%";
/**
 * Which KPI a metric explains or moves, and in what role. Stored beside the
 * hashed spec like `display`, so adding or changing it never forks the series.
 */
export const MetricServesSchema = z.strictObject({
	kpi: z.string().min(1).max(40),
	role: z.enum(["input", "diagnostic", "guardrail"]),
});
export type MetricServes = z.infer<typeof MetricServesSchema>;
export type MetricServesRole = MetricServes["role"];
/** A display a metric of this unit can honour. */
export function displayFits(display: MetricDisplay, unit: string): boolean {
	return display !== "slo" || unit === SLO_UNIT;
}
export const KpiBindingSchema = z.strictObject({
	metricId: z.string().min(1).max(40),
	comparator: z.enum(["gte", "lte", "eq"]),
	target: z.strictObject({
		value: z.number().finite(),
		unit: z.string().min(1),
	}),
	evaluationAt: z.iso.datetime({ offset: true }).optional(),
	baselineObservationId: z.uuid().optional(),
	/**
	 * Opt in to a red breach. Before the deadline a good reading that misses the
	 * comparator is `failing` / `target_breached` instead of `behind`. Absent: unchanged.
	 */
	breach: z.literal("failing").optional(),
});
export const KpiBindingsSchema = z.array(KpiBindingSchema).max(20);
export type KpiBinding = z.infer<typeof KpiBindingSchema>;
/**
 * A metric's own health band: a binding without the identity, deadline or
 * baseline fields. Assessed as a synthetic binding through the one KPI path.
 */
export const MetricBandSchema = KpiBindingSchema.omit({
	metricId: true,
	evaluationAt: true,
	baselineObservationId: true,
});
export type MetricBand = z.infer<typeof MetricBandSchema>;

/** Reason codes are an enum, never free text, so every reader can act on them. */
export const KpiReasonSchema = z.enum([
	"no_binding",
	"calculator_unavailable",
	"metric_unavailable",
	"metric_authority_unavailable",
	"insufficient_history",
	"zero_denominator",
	"history_unavailable",
	"source_failed",
	"source_timeout",
	"incomplete_or_invalid_source",
	"unit_mismatch",
	"no_reading_at_evaluation",
	"evaluation_not_due",
	"baseline_unavailable_or_incompatible",
	"fixed_prediction_and_baseline_required",
	"target_breached",
]);
export type KpiReason = z.infer<typeof KpiReasonSchema>;
/** First matching rule wins; see metric-foundation-design "One assessment". */
export const KpiStatusSchema = z.enum([
	"not_measured",
	"evaluating",
	"met",
	"missed",
	"unresolved",
	"building",
	"failing",
	"delayed",
	"on_track",
	"behind",
]);
export type KpiStatus = z.infer<typeof KpiStatusSchema>;
export const KpiAssessmentSchema = z.object({
	status: KpiStatusSchema,
	reason: KpiReasonSchema.nullable(),
	/** Value the status speaks about: fresh, last good (delayed/failing) or the evaluation reading. */
	value: z.number().finite().nullable(),
	unit: z.string(),
	observationId: z.uuid().nullable(),
	observedAt: z.string().nullable(),
	comparator: KpiBindingSchema.shape.comparator,
	target: KpiBindingSchema.shape.target,
	deadline: z.string().nullable(),
	/** Display only. Never decides status. Units per week. */
	pace: z.object({
		observed: z.number().finite().nullable(),
		needed: z.number().finite().nullable(),
	}),
});
export type KpiAssessment = z.infer<typeof KpiAssessmentSchema>;

/**
 * A stored `metric_spec`: the strict spec plus the author's optional display,
 * `serves` link and health `band`. All three sit beside the spec, so none of
 * them enters the series hash.
 */
export const StoredMetricSpecSchema = MetricSpecSchema.extend({
	display: MetricDisplaySchema.optional(),
	serves: MetricServesSchema.optional(),
	band: MetricBandSchema.optional(),
});
/** The core stored spec: the strict spec plus display. An invalid core drops the row. */
const StoredCoreSpecSchema = MetricSpecSchema.extend({
	display: MetricDisplaySchema.optional(),
});
/** An annex field (`serves` or `band`) that failed its schema, with where it failed. */
export const AnnexInvalidSchema = z.object({
	field: z.enum(["serves", "band"]),
	/** Zod issue locations, e.g. `serves.role:invalid_value`; never the stored values. */
	issues: z.array(z.string()),
});
export type AnnexInvalid = z.infer<typeof AnnexInvalidSchema>;
/**
 * Parse a stored `metric_spec` in two parts. The core spec (and display) is
 * strict: invalid throws, and the caller skips the row. `serves` and `band`
 * are an annex: an invalid one is ignored and reported in `invalid`, never
 * dropping the metric, so it still computes and is assessed with its spec.
 */
export function parseStoredMetricSpec(stored: unknown): {
	spec: MetricSpec;
	display: MetricDisplay | undefined;
	serves: MetricServes | undefined;
	band: MetricBand | undefined;
	invalid: AnnexInvalid[];
} {
	const raw =
		stored && typeof stored === "object" && !Array.isArray(stored)
			? (stored as Record<string, unknown>)
			: {};
	const { serves: rawServes, band: rawBand, ...core } = raw;
	const { display, ...spec } = StoredCoreSpecSchema.parse(
		stored && typeof stored === "object" && !Array.isArray(stored)
			? core
			: stored,
	);
	const invalid: AnnexInvalid[] = [];
	const annex = <T>(
		field: "serves" | "band",
		schema: z.ZodType<T>,
		value: unknown,
	): T | undefined => {
		if (value === undefined) return undefined;
		const r = schema.safeParse(value);
		if (r.success) return r.data;
		invalid.push({
			field,
			issues: r.error.issues.map(
				(i) => `${[field, ...i.path].join(".")}:${i.code}`,
			),
		});
		return undefined;
	};
	return {
		spec,
		display,
		serves: annex("serves", MetricServesSchema, rawServes),
		band: annex("band", MetricBandSchema, rawBand),
		invalid,
	};
}
export const MetricComputeInputSchema = z.strictObject({
	requestKey: z.string().min(1).max(160),
	evaluationAt: z.iso.datetime({ offset: true }).optional(),
});
export const MetricObservationSchema = z.object({
	id: z.uuid(),
	metricId: z.string(),
	definitionRevision: z.string(),
	definitionHash: z.string(),
	calculatorVersion: z.string(),
	paramsHash: z.string(),
	node: z.string(),
	environment: z.string(),
	dataScope: z.string(),
	window: z.object({ start: z.string(), end: z.string() }),
	sourceWatermarks: z.array(
		z.object({ source: z.string(), asOf: z.string().nullable() }),
	),
	scheduledFor: z.string().optional(),
	observedAt: z.string().nullable(),
	status: z.enum(["pending", "ok", "unavailable", "error"]),
	value: z.number().finite().nullable(),
	unit: z.string(),
	reason: z.string().nullable(),
	evidenceRefs: z.array(z.string()),
});
export type MetricObservation = z.infer<typeof MetricObservationSchema>;
export const MetricViewSchema = z.object({
	definition: z.object({
		id: z.string(),
		title: z.string(),
		revision: z.string(),
		spec: MetricSpecSchema,
		display: MetricDisplaySchema.optional(),
		serves: MetricServesSchema.optional(),
		band: MetricBandSchema.optional(),
		/** Annex fields the stored spec carried but that failed their schema; ignored, never silent. */
		annexInvalid: z.array(AnnexInvalidSchema).optional(),
	}),
	latestAttempt: MetricObservationSchema.nullable(),
	lastGood: MetricObservationSchema.nullable(),
	viewState: z.enum(["ok", "stale", "pending", "unavailable", "error"]),
	/** The latest reading against the metric's own `band`; absent without a band. */
	bandAssessment: KpiAssessmentSchema.optional(),
});
export type MetricView = z.infer<typeof MetricViewSchema>;
/** GET /api/v1/metrics/{id}: the view plus its recent readings. */
export const MetricReadResponseSchema = MetricViewSchema.extend({
	history: z.array(MetricObservationSchema),
});
export type MetricReadResponse = z.infer<typeof MetricReadResponseSchema>;
export const MetricSnapshotSchema = z.object({
	definition: MetricViewSchema.shape.definition,
	observation: MetricObservationSchema,
});
export type MetricSnapshot = z.infer<typeof MetricSnapshotSchema>;
export const MetricListInputSchema = z.strictObject({
	limit: z.number().int().min(1).max(50).optional(),
	after: z.string().min(1).max(160).optional(),
});
export type MetricListInput = z.infer<typeof MetricListInputSchema>;
export const MetricListResponseSchema = z.object({
	items: z.array(MetricViewSchema),
	nextCursor: z.string().nullable(),
	catalog: z.array(
		z.object({
			id: z.string(),
			unit: z.string(),
			limits: z.object({
				timeoutMs: z.number().positive(),
				maxSourceCalls: z.number().int().nonnegative(),
				maxRows: z.number().int().nonnegative(),
				maxResponseBytes: z.number().int().nonnegative(),
			}),
			paramsSchema: z.record(z.string(), z.unknown()),
		}),
	),
});
export type MetricDefinition = MetricView["definition"];
export interface MetricScope {
	node: string;
	environment: string;
	dataScope: string;
}
export interface MetricBudget {
	timeoutMs: number;
	maxSourceCalls: number;
	maxRows: number;
	maxResponseBytes: number;
}
export interface MetricSample {
	value: number;
	unit: string;
	complete: boolean;
	sourceWatermarks: MetricObservation["sourceWatermarks"];
	evidenceRefs: string[];
	/** Why an incomplete sample is unknown, e.g. zero_denominator or history_unavailable. */
	reason?: KpiReason;
}
export type EditsStage = "windowCommits" | "workDiff" | "knowledgeDiff";
export type EditsTimingUpdate =
	| { stage: EditsStage; phase: "start" | "ok" | "error" }
	| { stage: EditsStage; phase: "counts"; rows: number; bytes?: number };
export interface EditsSourceTiming {
	windowCommits: {
		state: "not_started" | "running" | "ok" | "error";
		durationMs: number | null;
	};
	workDiff: {
		state: "not_started" | "running" | "ok" | "error";
		durationMs: number | null;
	};
	knowledgeDiff: {
		state: "not_started" | "running" | "ok" | "error";
		durationMs: number | null;
	};
	windowCommitCount: number | null;
	workRows: number | null;
	workBytes: number | null;
	knowledgeRows: number | null;
	knowledgeBytes: number | null;
}
export interface CalculatorContext {
	editsTiming?(update: EditsTimingUpdate): void;
	window: MetricObservation["window"];
	signal: AbortSignal;
	budget: Readonly<MetricBudget>;
	read<T>(
		source: (signal: AbortSignal, budget: Readonly<MetricBudget>) => Promise<T>,
	): Promise<T>;
}
export interface MetricCalculator {
	/** Snapshot calculators cannot claim a historical evaluation window. */
	historicalWindows?: boolean;
	id: string;
	unit: string;
	/** Unit for one parameterization when outputs differ (for example ratio vs items). */
	unitFor?(params: unknown): string;
	/** How this calculator's readings read best; a metric definition may override it. */
	display?: MetricDisplay;
	/** Display for one parameterization when outputs differ (ratio → progress, count → volume). */
	displayFor?(params: unknown): MetricDisplay;
	/** Width of the measured interval [end - windowSeconds, end). Absent means an instant. */
	windowSeconds?(params: unknown): number;
	paramsSchema: z.ZodType;
	budget: Readonly<MetricBudget>;
	compute(params: unknown, context: CalculatorContext): Promise<MetricSample>;
}
export interface MetricDefinitionsPort {
	get(id: string): Promise<MetricDefinition | null>;
	getMany?(ids: readonly string[]): Promise<MetricDefinition[]>;
	list(
		limit: number,
		after?: string,
	): Promise<{ items: MetricDefinition[]; nextCursor: string | null }>;
}
export interface MetricObservationsPort {
	predictionReadBatch?(
		requests: readonly {
			metricId: string;
			baselineObservationId: string;
			evaluationAt: string;
		}[],
	): Promise<
		readonly {
			baseline: MetricSnapshot | null;
			latest: MetricObservation | null;
			lastGood: MetricObservation | null;
			evaluation: MetricObservation | null;
		}[]
	>;
	workReadBatch?(
		requests: readonly {
			metricId: string;
			definitionHash: string;
			baselineObservationId: string | null;
		}[],
	): Promise<
		readonly {
			baseline: MetricSnapshot | null;
			latest: MetricObservation | null;
		}[]
	>;
	request(
		metricId: string,
		requestKey: string,
		requestHash: string,
	): Promise<MetricSnapshot | null>;
	reserve(input: {
		requestKey: string;
		requestHash: string;
		snapshot: MetricSnapshot;
		leaseMs: number;
	}): Promise<{ snapshot: MetricSnapshot; leaseToken: string | null }>;
	complete(
		id: string,
		token: string,
		result: MetricObservation,
	): Promise<MetricObservation | null>;
	history(
		metricId: string,
		definitionHash: string,
		limit: number,
	): Promise<MetricObservation[]>;
	get(id: string): Promise<MetricObservation | null>;
	lastGood(
		metricId: string,
		definitionHash: string,
	): Promise<MetricObservation | null>;
	/**
	 * Backward-only fixed evaluation: latest ok reading with window.end in
	 * [evaluationAt - maxAge, evaluationAt] and observedAt <= evaluationAt + maxAge.
	 */
	at(
		metricId: string,
		definitionHash: string,
		evaluationAt: string,
		maxAgeSeconds: number,
	): Promise<MetricObservation | null>;
	/** Aligned, validated half-open buckets; never filled or carried forward. */
	buckets(
		metricId: string,
		definitionHash: string,
		range: MetricHistoryInput,
	): Promise<MetricHistory["buckets"]>;
	snapshot(id: string): Promise<MetricSnapshot | null>;
	scheduledAttempts(
		metricId: string,
		definitionHash: string,
		slot: string,
	): Promise<MetricObservation[]>;
	expireLeases(): Promise<void>;
	cursor(): Promise<string | null>;
	advanceCursor(id: string): Promise<void>;
}
export type MetricAction = "read" | "compute";
export class MetricError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
		this.name = "MetricError";
	}
}

export const MetricHistoryStepSchema = z.enum(["1h", "1d", "1w"]);
export type MetricHistoryStep = z.infer<typeof MetricHistoryStepSchema>;
export const MetricHistoryInputSchema = z.strictObject({
	from: z.iso.datetime({ offset: true }),
	to: z.iso.datetime({ offset: true }),
	step: MetricHistoryStepSchema,
});
export type MetricHistoryInput = z.infer<typeof MetricHistoryInputSchema>;
/** Half-open [start, end). Value is the last ok reading; empty buckets are never filled. */
export const MetricHistoryBucketSchema = z.object({
	start: z.string(),
	end: z.string(),
	status: z.enum(["ok", "error", "unavailable", "missing"]),
	value: z.number().finite().nullable(),
	observationId: z.uuid().nullable(),
});
export const MetricHistorySchema = z.object({
	metricId: z.string(),
	unit: z.string(),
	step: MetricHistoryStepSchema,
	from: z.string(),
	to: z.string(),
	buckets: z.array(MetricHistoryBucketSchema).max(400),
});
export type MetricHistory = z.infer<typeof MetricHistorySchema>;

/**
 * A metric's latest reading as the goal read lists it: the state of the newest
 * attempt, and the last good value with its time. Present for every listed
 * metric, banded or not.
 */
export const MetricLatestSchema = z.object({
	viewState: MetricViewSchema.shape.viewState,
	/** The last good value; null when no reading was ok. Never zero for unknown. */
	value: z.number().finite().nullable(),
	unit: z.string(),
	/** When the last good value was observed. */
	observedAt: z.string().nullable(),
	/** Why the newest attempt is not ok; null when it is, or when there is no attempt. */
	reason: z.string().nullable(),
});
export type MetricLatest = z.infer<typeof MetricLatestSchema>;
/** A registered metric that serves one KPI, assessed against its own band (latest reading only). */
export const ServedMetricSchema = z.object({
	metric: z.object({
		id: z.string(),
		title: z.string(),
		calculatorId: z.string(),
		role: MetricServesSchema.shape.role,
	}),
	/** Null when the metric declares no band: it is listed, never judged. */
	assessment: KpiAssessmentSchema.nullable(),
	/** The latest reading, banded or not. Absent from servers older than 0.10.0. */
	latest: MetricLatestSchema.optional(),
});
export type ServedMetric = z.infer<typeof ServedMetricSchema>;
/**
 * A metric whose `serves.kpi` names no bound KPI, names a KPI only a bet binds
 * (`serves_bet_kpi`), or whose `serves`/`band` is invalid: reported, never hidden.
 */
export const MetricOrphanSchema = z.object({
	metricId: z.string(),
	/** The metric's title. Absent from servers older than 0.10.0. */
	title: z.string().optional(),
	/** The KPI the metric names; null when `serves` is invalid. */
	kpi: z.string().nullable(),
	reason: z.enum([
		"serves_unknown_kpi",
		"serves_bet_kpi",
		"serves_invalid",
		"band_invalid",
	]),
	/** Zod issue locations for an invalid annex field; absent for an unknown KPI. */
	issues: z.array(z.string()).optional(),
	assessment: KpiAssessmentSchema.nullable(),
	/** The latest reading, banded or not. Absent from servers older than 0.10.0. */
	latest: MetricLatestSchema.optional(),
});
export type MetricOrphan = z.infer<typeof MetricOrphanSchema>;
/** A registered metric that declares no `serves` and that no goal binds as a KPI: it explains no goal KPI (goal-metrics-vs-telemetry axiom 3). A bet-only KPI metric is listed too. */
export const UnboundMetricSchema = z.object({
	metric: z.object({
		id: z.string(),
		title: z.string(),
		calculatorId: z.string(),
	}),
	/** Null when the metric declares no band: it is listed, never judged. */
	assessment: KpiAssessmentSchema.nullable(),
	latest: MetricLatestSchema,
});
export type UnboundMetric = z.infer<typeof UnboundMetricSchema>;
/** One goal-progress read model shared by the Goals and Metrics views, HTTP and agent tools. */
export const GoalKpiSchema = z.object({
	binding: KpiBindingSchema,
	metric: z
		.object({
			id: z.string(),
			title: z.string(),
			calculatorId: z.string(),
			cadenceSeconds: z.number().int().nullable(),
			maxAgeSeconds: z.number().int(),
			display: MetricDisplaySchema.optional(),
		})
		.nullable(),
	assessment: KpiAssessmentSchema,
	/** 30 daily buckets ending at the current UTC day; null when unreadable. */
	trend: MetricHistorySchema.nullable(),
	/**
	 * The last 24 hourly buckets for a metric refreshed hourly or faster; absent
	 * or null otherwise. Lets a young series show its shape before it has days.
	 */
	recent: MetricHistorySchema.nullable().optional(),
	/** Metrics that serve this KPI; absent when none do or metrics are unavailable. */
	served: z.array(ServedMetricSchema).optional(),
});
export const GoalHypothesisSchema = z.object({
	id: z.string(),
	title: z.string(),
	evaluateAt: z.string().nullable(),
	predictions: z.array(
		z.object({
			binding: KpiBindingSchema,
			baselineValue: z.number().finite().nullable(),
			/** Baseline reading's window.end, for drawing the bet window. */
			baselineAt: z.string().nullable(),
			assessment: KpiAssessmentSchema,
		}),
	),
	outcome: z
		.object({ id: z.string(), title: z.string(), supports: z.boolean() })
		.nullable(),
});
export const GoalProgressSchema = z.object({
	id: z.string(),
	title: z.string(),
	evaluateAt: z.string().nullable(),
	configurationError: z.boolean(),
	kpis: z.array(GoalKpiSchema),
	hypotheses: z.array(GoalHypothesisSchema),
	moreHypotheses: z.boolean(),
	hypothesesUnavailable: z.boolean(),
});
export type GoalProgress = z.infer<typeof GoalProgressSchema>;
export const GoalsProgressSchema = z.object({
	goals: z.array(GoalProgressSchema),
	asOf: z.string(),
	environment: z.string(),
	/** Metrics serving a KPI that no goal binds. Absent when metrics are unavailable. */
	orphans: z.array(MetricOrphanSchema).optional(),
	/** Metrics that declare no `serves`. Absent when metrics are unavailable. */
	unbound: z.array(UnboundMetricSchema).optional(),
	/** True when more definitions exist than one read scans, so `served`/`orphans`/`unbound` may be incomplete. */
	servedTruncated: z.boolean().optional(),
	/** Error code when the served read failed (for example metric_authority_unavailable); `served`/`orphans`/`unbound` are then absent. */
	servedUnavailable: z.string().optional(),
});
export type GoalsProgress = z.infer<typeof GoalsProgressSchema>;
