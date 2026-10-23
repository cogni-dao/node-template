// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-store/analytics/doltgres`
 * Purpose: Metadata and semantic-change projections for current knowledge activity.
 * Scope: Injected read clients only; no connection lifecycle, branch checkout or authorization.
 * Invariants: PAGE_LOAD_DB_ONLY; NO_CONTENT_HYDRATION; SQL_ROW_LIMIT_WITH_SENTINEL.
 * Side-effects: Serial SELECTs on the host's existing node-local main read clients.
 * Notes: LIMIT bounds returned rows, not TEXT bytes or Dolt diff computation. Candidate cost proof is required.
 * Links: https://cognidao.org/work/items/task.5329
 * @public
 */
import { escapeRef, escapeValue } from "../adapters/doltgres/util.js";
import {
  ANALYTICS_BUDGET,
  type AnalyticsReadSources,
  DOLTGRES_ANALYTICS_VERSION,
} from "../analytics.js";

/** Structural seam accepts postgres.js without owning a pool or dependency lifecycle. */
export interface AnalyticsSqlReader {
  unsafe(query: string): PromiseLike<readonly Record<string, unknown>[]>;
}

function sentinelLimit(limit: number, maximum: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error("invalid_analytics_limit");
  }
  return limit + 1;
}

// Doltgres historically persisted brace-wrapped commit results; normalize only that wrapper.
function commitHash(value: unknown): string {
  const raw = String(value ?? "");
  const ref = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw;
  if (!/^[0-9a-v]{32}$/.test(ref))
    throw new Error("invalid_contribution_receipt");
  return ref;
}

const changedFields = ["title", "content", "use_when", "entry_type", "domain"];
// Explicit null-safe inequality: null and empty text are different content.
const contentChanged = changedFields
  .map(
    (field) =>
      `(from_${field} <> to_${field} OR (from_${field} IS NULL AND to_${field} IS NOT NULL) OR (from_${field} IS NOT NULL AND to_${field} IS NULL))`
  )
  .join(" OR ");

/** Bind only already-authorized node-local read clients. Caller authenticates before invoking. */
export function createDoltgresAnalyticsSources(input: {
  knowledgeSql: AnalyticsSqlReader;
  contributionSql?: AnalyticsSqlReader;
}): AnalyticsReadSources {
  const knowledge = input.knowledgeSql;
  const contributions = input.contributionSql ?? knowledge;
  return {
    provenance: {
      inventory: {
        adapterVersion: DOLTGRES_ANALYTICS_VERSION,
        scanWindow: null,
        caps: {
          domains: ANALYTICS_BUDGET.domains,
          atoms: ANALYTICS_BUDGET.atoms,
          rowsPerCall: ANALYTICS_BUDGET.atoms + 1,
        },
      },
      backlog: {
        adapterVersion: DOLTGRES_ANALYTICS_VERSION,
        scanWindow: null,
        caps: {
          contributions: ANALYTICS_BUDGET.contributions,
          rowsPerCall: ANALYTICS_BUDGET.contributions + 1,
        },
      },
      changes: {
        adapterVersion: DOLTGRES_ANALYTICS_VERSION,
        scanWindow: null,
        caps: {
          contributions: ANALYTICS_BUDGET.contributions,
          diffs: ANALYTICS_BUDGET.diffs,
          changes: ANALYTICS_BUDGET.changes,
          rowsPerCall: ANALYTICS_BUDGET.changes + 1,
        },
      },
    },
    async domains() {
      const rows = await knowledge.unsafe(
        `SELECT DISTINCT domain FROM knowledge ORDER BY domain LIMIT ${ANALYTICS_BUDGET.domains + 1}`
      );
      return rows.map((row) => String(row.domain));
    },
    async atoms(domain, limit) {
      const rows = await knowledge.unsafe(
        `SELECT id, title, domain, entry_type, confidence_pct, source_ref FROM knowledge WHERE domain = ${escapeValue(domain)} ORDER BY id LIMIT ${sentinelLimit(limit, ANALYTICS_BUDGET.atoms)}`
      );
      return rows.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        domain: String(row.domain),
        entryType: row.entry_type == null ? null : String(row.entry_type),
        confidencePct:
          row.confidence_pct == null ? null : Number(row.confidence_pct),
        sourceRef: row.source_ref == null ? null : String(row.source_ref),
      }));
    },
    async contributions(state, limit) {
      if (state !== "open" && state !== "merged")
        throw new Error("invalid_state");
      const rows = await contributions.unsafe(
        `SELECT id, resolved_at, base_commit, head_commit FROM knowledge_contributions WHERE state = ${escapeValue(state)} ORDER BY created_at DESC, id LIMIT ${sentinelLimit(limit, ANALYTICS_BUDGET.contributions)}`
      );
      return rows.map((row) => ({
        contributionId: String(row.id),
        resolvedAt:
          row.resolved_at == null
            ? null
            : new Date(row.resolved_at as string).toISOString(),
        baseCommit: String(row.base_commit),
        headCommit: row.head_commit == null ? null : String(row.head_commit),
      }));
    },
    async changeIds(receipt, limit) {
      const base = commitHash(receipt.baseCommit);
      const head = commitHash(receipt.headCommit ?? receipt.baseCommit);
      // Use equality predicates: Doltgres system-table IN analysis can fail
      // underneath LIMIT (dolthub/doltgresql#1405, #3115).
      const rows = await contributions.unsafe(
        `SELECT from_id, to_id FROM dolt_diff(${escapeRef(base)}, ${escapeRef(head)}, 'knowledge') WHERE diff_type = 'added' OR diff_type = 'removed' OR (diff_type = 'modified' AND (${contentChanged})) ORDER BY to_id, from_id LIMIT ${sentinelLimit(limit, ANALYTICS_BUDGET.changes)}`
      );
      return rows.map((row) => String(row.to_id ?? row.from_id));
    },
  };
}
