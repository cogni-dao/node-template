// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/contribution-author`
 * Purpose: Reads who opened an inbox (a contribution), for the work-items `ContributionAuthorPort` (task.0028): the independence check of a review artifact whose subject is an inbox.
 * Scope: One lock-free read of `knowledge_contributions` on the caller's pooled client. Does not write, checkout a branch, or take a writer lock. The work-items package never reads knowledge tables; it asks this port.
 * Invariants:
 *   - NO_CHECKOUT: the read is a plain SELECT on main; it never waits on a writer lock.
 *   - AUTHOR_IS_PRINCIPAL_ID: the author is the contribution's `principal_id`, the principal the contribution API stamped at creation.
 *   - UNKNOWN_IS_NULL: an unknown inbox is `null`, never an error and never a guess; a failed read throws.
 *   - ABORT_IS_HONORED: an aborted signal stops the read.
 * Side-effects: IO (one read)
 * Links: hub work-cicd-gates-design (Independence), change-history-design (EntryResolver port pattern)
 * @public
 */

import { escapeValue } from "./util.js";

/** A postgres.js-shaped executor; only `unsafe` is used, with escaped values. */
export interface ContributionAuthorSql {
  unsafe(query: string): PromiseLike<readonly Record<string, unknown>[]>;
}

/** Structurally the work-items `ContributionAuthorPort`; this package does not import work-items. */
export interface ContributionAuthors {
  principalOf(contributionId: string, signal: AbortSignal): Promise<string | null>;
}

export function createDoltgresContributionAuthors(
  sql: ContributionAuthorSql
): ContributionAuthors {
  return {
    async principalOf(contributionId, signal) {
      signal.throwIfAborted();
      const rows = await sql.unsafe(
        `SELECT principal_id FROM knowledge_contributions WHERE id = ${escapeValue(contributionId)} LIMIT 1`
      );
      signal.throwIfAborted();
      const principal = rows[0]?.principal_id;
      return typeof principal === "string" && principal.length > 0 ? principal : null;
    },
  };
}
