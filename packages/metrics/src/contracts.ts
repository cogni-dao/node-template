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
export interface MetricDefinition {
	id: string;
	title: string;
	revision: string;
	spec: MetricSpec;
}
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
export interface MetricSnapshot {
	definition: MetricDefinition;
	observation: MetricObservation;
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
	at(
		metricId: string,
		definitionHash: string,
		evaluationAt: string,
	): Promise<MetricObservation | null>;
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
