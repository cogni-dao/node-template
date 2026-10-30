// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/contracts`
 * Purpose: Canonical knowledge wire schema and pure knowledge/EDO capability contracts.
 * Scope: Pure schemas and types; no adapters, I/O or environment access.
 * Invariants: HTTP and tool read envelopes derive from this domain owner.
 * Side-effects: none
 * @public
 */

import { z } from "zod";

export const KnowledgeRowSchema = z.object({
	id: z.string(),
	domain: z.string(),
	entityId: z.string().nullable(),
	title: z.string(),
	content: z.string(),
	useWhen: z.string().nullable().optional(),
	entryType: z.string(),
	confidencePct: z.number().int().nullable(),
	sourceType: z.string(),
	sourceRef: z.string().nullable(),
	tags: z.array(z.string()).nullable(),
	/** ISO timestamp — a hypothesis's resolution date or a goal's `By:` deadline. */
	evaluateAt: z.string().nullable(),
	/** Namespaced resolver id on hypothesis/goal rows (`manual`, `agent`, `metric:<kpi>`). */
	resolutionStrategy: z.string().nullable(),
	createdAt: z.string().nullable(),
});
export type KnowledgeRow = z.infer<typeof KnowledgeRowSchema>;

export * from "./contracts/knowledge.js";
export * from "./contracts/edo.js";
