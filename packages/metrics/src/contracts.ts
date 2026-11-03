// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Measurement contracts. Nodes supply sources, authority and persistence. */
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
export const KpiBindingSchema = z.strictObject({
	metricId: z.string().min(1).max(40),
	comparator: z.enum(["gte", "lte", "eq"]),
	target: z.strictObject({
		value: z.number().finite(),
		unit: z.string().min(1),
	}),
	evaluationAt: z.iso.datetime({ offset: true }).optional(),
	baselineObservationId: z.uuid().optional(),
});
export const KpiBindingsSchema = z.array(KpiBindingSchema).max(20);
export type KpiBinding = z.infer<typeof KpiBindingSchema>;
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
	}),
	latestAttempt: MetricObservationSchema.nullable(),
	lastGood: MetricObservationSchema.nullable(),
	viewState: z.enum(["ok", "stale", "pending", "unavailable", "error"]),
});
export type MetricView = z.infer<typeof MetricViewSchema>;
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
export interface CalculatorContext {
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
	/** Width of the measured interval [end - windowSeconds, end). Absent means an instant. */
	windowSeconds?(params: unknown): number;
	paramsSchema: z.ZodType;
	budget: Readonly<MetricBudget>;
	compute(params: unknown, context: CalculatorContext): Promise<MetricSample>;
}
export interface MetricDefinitionsPort {
	get(id: string): Promise<MetricDefinition | null>;
	list(
		limit: number,
		after?: string,
	): Promise<{ items: MetricDefinition[]; nextCursor: string | null }>;
}
export interface MetricObservationsPort {
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
	/** Earliest ok reading of one series; drives the building rule. */
	firstGood(
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

/** One goal-progress read model shared by the Goals tab, HTTP and agent tools. */
export const GoalKpiSchema = z.object({
	binding: KpiBindingSchema,
	metric: z
		.object({
			id: z.string(),
			title: z.string(),
			calculatorId: z.string(),
			cadenceSeconds: z.number().int().nullable(),
			maxAgeSeconds: z.number().int(),
		})
		.nullable(),
	assessment: KpiAssessmentSchema,
	/** 30 daily buckets ending at the current UTC day; null when unreadable. */
	trend: MetricHistorySchema.nullable(),
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
});
export type GoalsProgress = z.infer<typeof GoalsProgressSchema>;
