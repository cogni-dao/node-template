// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/history-read`
 * Purpose: Framework-agnostic read of one work item's history for a node route (story.0023).
 * Scope: Takes a structural store, returns `{ status, body, log }`. Imports no web framework, auth, container or logger.
 * Invariants:
 *   - NEVER_THROWS: every failure becomes a 503 `history_unavailable`; a missing row is a 404.
 *   - ONE_TERMINAL_LOG: `log` carries counts, codes and, on failure, the database error code plus a 300-char single-line message (bug.0025); the route emits it once.
 *   - Event name is `work.items.history_read`.
 * Side-effects: IO (store reads through the injected store)
 * Links: hub change-history-design, change-history-fleet-adoption
 * @public
 */

import { workItemsHistoryOperation } from "./history-contract.js";
import type { HistoryEntry } from "./history.js";
import { toWorkItemId, type WorkItemId } from "./types.js";

/** The slice of a work-items store the handler reads. */
export interface WorkItemHistoryStore {
  get(id: WorkItemId): Promise<unknown>;
  history?(id: WorkItemId): Promise<readonly HistoryEntry[]>;
}

export interface HistoryReadLog {
  readonly event: "work.items.history_read";
  readonly status: 200 | 404 | 503;
  readonly outcome: "success" | "error";
  readonly versionCount?: number;
  readonly reasonCount?: number;
  readonly errorCode?: "not_found" | "history_unavailable";
  /** Set on a failed read so the route may warn with the error class. */
  readonly errorName?: string;
  /** Database error code (SQLSTATE) from the thrown error, when it carries one. */
  readonly dbCode?: string;
  /** First 300 chars of the thrown error's message, CR/LF collapsed. */
  readonly errorMessage?: string;
}

export interface WorkItemHistoryResult {
  readonly status: 200 | 404 | 503;
  readonly body: unknown;
  readonly log: HistoryReadLog;
}

const EVENT = "work.items.history_read" as const;
const DB_MESSAGE_MAX = 300;

/** Database error code and bounded single-line message for the failure log (bug.0025). */
export const errorDetail = (
  error: unknown
): { dbCode?: string; errorMessage?: string } => {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  return {
    ...(typeof code === "string" && { dbCode: code }),
    ...(typeof message === "string" && {
      errorMessage: message.replace(/[\r\n]+/g, " ").slice(0, DB_MESSAGE_MAX),
    }),
  };
};

export async function readWorkItemHistory(
  store: WorkItemHistoryStore,
  id: string
): Promise<WorkItemHistoryResult> {
  try {
    if (!store.history) throw new Error("work-item history is not available");
    const itemId = toWorkItemId(id);
    if (!(await store.get(itemId))) {
      return {
        status: 404,
        body: { error: `Work item not found: ${id}` },
        log: {
          event: EVENT,
          status: 404,
          outcome: "error",
          errorCode: "not_found",
        },
      };
    }
    const items = await store.history(itemId);
    const body = workItemsHistoryOperation.output.parse({ items });
    return {
      status: 200,
      body,
      log: {
        event: EVENT,
        status: 200,
        outcome: "success",
        versionCount: items.length,
        reasonCount: items.filter((v) => v.reason !== null).length,
      },
    };
  } catch (error) {
    return {
      status: 503,
      body: { error: "history_unavailable" },
      log: {
        event: EVENT,
        status: 503,
        outcome: "error",
        errorCode: "history_unavailable",
        errorName: (error as Error)?.name,
        ...errorDetail(error),
      },
    };
  }
}
