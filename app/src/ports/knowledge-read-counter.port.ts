// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/knowledge-read-counter.port`
 * Purpose: Count one agent atom read without touching the caller's latency or outcome (story.0061).
 * Scope: Interface only. The batched Postgres counter and its flush policy live in adapters.
 * Invariants: NEVER_BLOCKS — `count()` returns synchronously and never throws; AGENTS_ONLY — humans are never counted.
 * Side-effects: none (interface only)
 * Links: https://node-template.cognidao.org/knowledge/knowledge-usage-telemetry
 * @public
 */

/** Mirrors the `knowledge_read_daily` CHECK constraint in `@cogni/db-schema`. */
export type KnowledgeReaderClass = "internal_run" | "external_agent";

export interface KnowledgeRead {
  readonly atomId: string;
  /** `fail` only when the id does not exist (a 404 or a null get). */
  readonly outcome: "ok" | "fail";
  readonly principalId: string;
  readonly principalClass: KnowledgeReaderClass;
}

export interface KnowledgeReadCounter {
  count(read: KnowledgeRead): void;
}
