// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Serialize a stored row, preserving new canonical fields and existing null/default semantics. */
import type { KnowledgeRow } from "@cogni-dao/read-contracts/knowledge";
import type { Knowledge } from "./domain/schemas.js";

export function toKnowledgeRow(entry: Knowledge): KnowledgeRow {
  return {
    ...entry,
    entityId: entry.entityId ?? null,
    useWhen: entry.useWhen ?? null,
    entryType: entry.entryType ?? "finding",
    confidencePct: entry.confidencePct ?? null,
    sourceRef: entry.sourceRef ?? null,
    tags: entry.tags ?? null,
    evaluateAt: entry.evaluateAt ? entry.evaluateAt.toISOString() : null,
    resolutionStrategy: entry.resolutionStrategy ?? null,
    createdAt: entry.createdAt ? entry.createdAt.toISOString() : null,
  };
}
