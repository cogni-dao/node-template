// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import {
	KpiBindingSchema,
	MetricObservationSchema,
	MetricViewSchema,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
export const GoalReadingSchema = KpiBindingSchema.extend({
	baseline: MetricObservationSchema.nullable(),
	observation: MetricObservationSchema.nullable(),
	viewState: MetricViewSchema.shape.viewState,
	met: z.boolean().nullable(),
	reason: z.string().nullable(),
});
export const GoalProgressSchema = z.object({
	id: z.string(),
	title: z.string(),
	evaluateAt: z.string().nullable(),
	configurationError: z.boolean(),
	metrics: z.array(
		z.object({
			binding: KpiBindingSchema,
			reading: GoalReadingSchema,
			view: MetricViewSchema.nullable(),
			history: z.array(MetricObservationSchema),
		}),
	),
	hypotheses: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			evaluateAt: z.string().nullable(),
			predictions: z.array(GoalReadingSchema),
			outcome: z
				.object({ id: z.string(), title: z.string(), supports: z.boolean() })
				.nullable(),
		}),
	),
	moreHypotheses: z.boolean(),
	hypothesesUnavailable: z.boolean(),
});
export const GoalsProgressSchema = z.object({
	goals: z.array(GoalProgressSchema),
	asOf: z.string(),
	environment: z.string(),
});
export type GoalProgress = z.infer<typeof GoalProgressSchema>;
export type GoalsProgressData = z.infer<typeof GoalsProgressSchema>;
