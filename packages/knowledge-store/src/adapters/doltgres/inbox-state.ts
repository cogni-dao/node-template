// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/inbox-state`
 * Purpose: Reads an inbox's (a contribution's) current head and whether it is open, merged or closed, for the work-items `InboxStatePort` (task.0122): the status gates ask whether a design or deliverable inbox is still at the head a review pinned, and whether it merged.
 * Scope: One lock-free read of `knowledge_contributions` on the caller's pooled client. Does not write, checkout a branch, or take a writer lock. The work-items package never reads knowledge tables; it asks this port.
 * Invariants:
 *   - NO_CHECKOUT: the read is a plain SELECT on main; it never waits on a writer lock.
 *   - UNKNOWN_IS_NULL: an unknown inbox is `null`, never an error and never a guess; a failed read throws.
 *   - STATE_IS_THREE_WAY: `merged` and `open` come from the row's `state` (open, merged or closed); closed without merging is neither.
 *   - ABORT_IS_HONORED: an aborted signal rejects the call at once, even while the query is in flight (the read is raced against the signal, like the cite-resolver call).
 *   - NO_AUTHORSHIP: this port says nothing about who opened an inbox; no server check compares authors.
 * Side-effects: IO (one read)
 * Links: hub work-gate-enforcement (Facts), change-history-design (EntryResolver port pattern)
 * @public
 */

import { escapeValue } from "./util.js";

/** A postgres.js-shaped executor; only `unsafe` is used, with escaped values. */
export interface InboxStateSql {
  unsafe(query: string): PromiseLike<readonly Record<string, unknown>[]>;
}

/** Structurally the work-items `InboxStatePort`; this package does not import work-items. */
export interface InboxStates {
  /**
   * The inbox's current head commit and whether it merged or is still open. `null`: no such inbox. A throw is a failed read.
   * `head` is the contribution's `head_commit`, the commit a review pins.
   */
  stateOf(
    contributionId: string,
    signal: AbortSignal
  ): Promise<{ head: string | null; merged: boolean; open: boolean } | null>;
}

/** Rejects when `signal` aborts, so a hung read cannot hold the caller past its deadline. */
function abortion(signal: AbortSignal): { promise: Promise<never>; stop: () => void } {
  let stop = () => {};
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    stop = () => signal.removeEventListener("abort", onAbort);
  });
  // The race may settle first; an unobserved rejection must not surface.
  promise.catch(() => {});
  return { promise, stop };
}

export function createDoltgresInboxStates(sql: InboxStateSql): InboxStates {
  return {
    async stateOf(contributionId, signal) {
      signal.throwIfAborted();
      const aborted = abortion(signal);
      try {
        // ABORT_IS_HONORED: raced against the signal, because a query in flight does not see it.
        const rows = await Promise.race([
          Promise.resolve(
            sql.unsafe(
              `SELECT state, head_commit FROM knowledge_contributions WHERE id = ${escapeValue(contributionId)} LIMIT 1`
            )
          ),
          aborted.promise,
        ]);
        const row = rows[0];
        if (!row) return null;
        const head = row.head_commit;
        return {
          head: typeof head === "string" && head.length > 0 ? head : null,
          merged: row.state === "merged",
          open: row.state === "open",
        };
      } finally {
        aborted.stop();
      }
    },
  };
}
