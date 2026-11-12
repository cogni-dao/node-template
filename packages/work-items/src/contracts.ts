// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/contracts`
 * Purpose: Canonical work-item wire schemas and inferred read DTOs.
 * Scope: Pure schemas and types; no adapters, I/O or environment access.
 * Invariants: HTTP and tool read envelopes derive from this domain owner.
 * Side-effects: none
 * @public
 */

import { z } from "zod";

export const SubjectRefSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("user"), userId: z.string() }),
	z.object({ kind: z.literal("agent"), agentId: z.string() }),
	z.object({ kind: z.literal("system"), serviceId: z.string() }),
]);

export const ExternalRefSchema = z.object({
	system: z.string(),
	kind: z.string(),
	externalId: z.string().optional(),
	url: z.string().optional(),
	title: z.string().optional(),
});

const WorkItemScoresDtoSchema = z.record(
	z.string(),
	z.object({ v: z.number(), ev: z.string().optional() }),
);

const MoveReadingDtoSchema = z.object({
	value: z.number().nullable(),
	observedAt: z.string().nullable(),
	id: z.string().optional(),
	metricId: z.string().optional(),
	metricTitle: z.string().optional(),
	definitionRevision: z.string().optional(),
	definitionHash: z.string().optional(),
	calculatorVersion: z.string().optional(),
	paramsHash: z.string().optional(),
	node: z.string().optional(),
	environment: z.string().optional(),
	dataScope: z.string().optional(),
	window: z.object({ start: z.string(), end: z.string() }).optional(),
	sourceWatermarks: z
		.array(z.object({ source: z.string(), asOf: z.string().nullable() }))
		.optional(),
	status: z.enum(["pending", "ok", "unavailable", "error"]).optional(),
	unit: z.string().optional(),
	reason: z.string().nullable().optional(),
	evidenceRefs: z.array(z.string()).optional(),
	maxAgeSeconds: z.number().positive().optional(),
	viewState: z
		.enum(["ok", "stale", "pending", "unavailable", "error"])
		.optional(),
});

/**
 * The metric a move names, as the single-item read resolves it (task.0118). Derived on the
 * server from the metric definition; never stored on the item.
 */
export const MoveMetricContextSchema = z.object({
	id: z.string(),
	title: z.string(),
	unit: z.string(),
	display: z.enum(["progress", "slo", "volume"]).optional(),
});

/** The goal KPI a move serves: the moved metric itself when a goal binds it, else the KPI it `serves`. */
export const MoveKpiContextSchema = z.object({
	metricId: z.string(),
	title: z.string(),
	comparator: z.enum(["gte", "lte", "eq"]),
	target: z.object({ value: z.number(), unit: z.string() }),
	/** The KPI's latest assessment; absent when it could not be read, never guessed. */
	status: z.string().optional(),
});

export const MoveGoalContextSchema = z.object({
	id: z.string(),
	title: z.string(),
});

/** Links per page; the citations read serves five. */
export const CITATION_LINKS_PAGE_MAX = 5;

/** One depth-1 citation endpoint and link, the wire shape of `GET /api/v1/citations/{id}`. */
export const CitationEndpointDtoSchema = z.object({
	id: z.string(),
	kind: z.enum(["knowledge", "work"]),
	title: z.string().nullable(),
	href: z.string(),
});
export const CitationLinkDtoSchema = z.object({
	id: z.string(),
	direction: z.enum(["out", "in"]),
	citationType: z.string(),
	source: CitationEndpointDtoSchema,
	target: CitationEndpointDtoSchema,
	context: z.string().nullable(),
	/** This side's reading from CITATION_TYPE_DEFINITIONS ("supported by" on the cited side). */
	label: z.string(),
	tone: z.enum(["positive", "negative", "warning", "neutral", "muted"]),
});
/** One bounded page of citation links: the `GET /api/v1/citations/{id}` body. */
export const CitationLinksPageSchema = z.object({
	links: z.array(CitationLinkDtoSchema).max(CITATION_LINKS_PAGE_MAX),
	nextCursor: z.string().nullable(),
});

/** An item's first page of citation links (`?include=links`); `unavailable` is never an empty list. */
export const WorkItemLinksSchema = z.object({
	items: z.array(CitationLinkDtoSchema).max(CITATION_LINKS_PAGE_MAX),
	nextCursor: z.string().nullable(),
	unavailable: z.literal(true).optional(),
});
export type WorkItemLinks = z.infer<typeof WorkItemLinksSchema>;

/**
 * One move as a read returns it (story.0033). A list read and a write return the stored
 * three fields; a single-item read adds the readings and the verdict at read time, and
 * (task.0118) the metric with the KPI and goal it serves.
 */
export const WorkItemMoveDtoSchema = z.object({
	metricId: z.string(),
	direction: z.enum(["up", "down"]).nullable(),
	baselineObservationId: z.string().nullable(),
	baseline: MoveReadingDtoSchema.nullable().optional(),
	current: MoveReadingDtoSchema.nullable().optional(),
	moved: z
		.enum(["as_declared", "against", "flat", "unknown"])
		.nullable()
		.optional(),
	unknownReason: z
		.enum([
			"no_baseline",
			"baseline_unreadable",
			"no_current",
			"metric_deprecated",
			"incompatible_reading",
			"projection_budget",
			"metrics_unavailable",
		])
		.optional(),
	// Single-item read only (task.0118). `kpi` and `goal` are absent when the metric serves no
	// goal KPI; `context: "unavailable"` means resolution failed, so none of the three is guessed.
	metric: MoveMetricContextSchema.optional(),
	kpi: MoveKpiContextSchema.optional(),
	goal: MoveGoalContextSchema.optional(),
	context: z.literal("unavailable").optional(),
});

export const WorkItemDtoSchema = z.object({
	id: z.string(),
	type: z.string(),
	title: z.string(),
	status: z.string(),
	priority: z.number().optional(),
	rank: z.number().optional(),
	rankScore: z.number().optional(),
	estimate: z.number().optional(),
	scores: WorkItemScoresDtoSchema.optional(),
	// Absent = no declaration; `[]` = declared to move nothing (the edit reason says why).
	moves: z.array(WorkItemMoveDtoSchema).optional(),
	summary: z.string().optional(),
	outcome: z.string().optional(),
	projectId: z.string().optional(),
	parentId: z.string().optional(),
	node: z.string().optional(),
	assignees: z.array(SubjectRefSchema),
	externalRefs: z.array(ExternalRefSchema),
	actor: z.string().optional(),
	labels: z.array(z.string()),
	specRefs: z.array(z.string()),
	branch: z.string().optional(),
	pr: z.string().optional(),
	reviewer: z.string().optional(),
	revision: z.number(),
	blockedBy: z.string().optional(),
	deployVerified: z.boolean(),
	claimedByRun: z.string().optional(),
	claimedAt: z.string().optional(),
	lastCommand: z.string().optional(),
	// Single-item read with `include=links` only (task.0118).
	links: WorkItemLinksSchema.optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type WorkItemDto = z.infer<typeof WorkItemDtoSchema>;

/** Browser list projection; detail and operational fields remain on WorkItemDto. */
export const WorkItemSummarySchema = WorkItemDtoSchema.pick({
	id: true,
	title: true,
	type: true,
	status: true,
	priority: true,
	scores: true,
	projectId: true,
	estimate: true,
	labels: true,
	moves: true,
	createdAt: true,
	updatedAt: true,
});
export type WorkItemSummary = z.infer<typeof WorkItemSummarySchema>;
