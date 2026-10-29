// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/knowledge-entry`
 * Purpose: The ONE mapper from the store's `Knowledge` row to the `KnowledgeEntry` tool envelope.
 * Scope: Pure mapping. Shared by the knowledge and EDO capabilities so a field is never
 *   carried by one and dropped by the other. Does not perform I/O.
 * Invariants:
 *   - ENVELOPE_BY_CONSTRUCTION: typed on the store's own `Knowledge`; every `KnowledgeEntry`
 *     field is required, so a producer that forgets one fails to compile.
 *   - WIRE_DEFAULTS: mirrors the `GET /api/v1/knowledge/{id}` mapping (entryType defaults to
 *     "finding", absent nullable columns are `null`, dates are ISO strings).
 * Side-effects: none
 * Links: knowledge entry `agent-tool-context-envelope`
 * @internal
 */

import type { KnowledgeEntry } from "@cogni/ai-tools";

import type { Knowledge } from "./domain/schemas.js";

/** ISO string for a Date (or an ISO string a driver already returned); `null` when absent/invalid. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toKnowledgeEntry(k: Knowledge): KnowledgeEntry {
  return {
    id: k.id,
    domain: k.domain,
    entityId: k.entityId ?? null,
    title: k.title,
    content: k.content,
    useWhen: k.useWhen ?? null,
    entryType: k.entryType ?? "finding",
    confidencePct: k.confidencePct ?? null,
    sourceType: k.sourceType,
    sourceRef: k.sourceRef ?? null,
    tags: k.tags ?? null,
    evaluateAt: toIso(k.evaluateAt),
    resolutionStrategy: k.resolutionStrategy ?? null,
    createdAt: toIso(k.createdAt),
  };
}
