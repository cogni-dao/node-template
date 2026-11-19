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
 *   - REFS_VIEW_IS_ADDITIVE (story.0058): without `view` the answer is unchanged (up to 50 entries with `diff`). `view=refs`
 *     returns one page of 20 refs without `diff` and `nextCursor`; a cursor outside this item's history, or an unknown
 *     view, is a 400 `invalid_input`.
 * Side-effects: IO (store reads through the injected store)
 * Links: hub change-history-design, change-history-fleet-adoption
 * @public
 */

import {
  HISTORY_REFS_PAGE,
  type HistoryRef,
  type HistoryRefsPage,
  workItemsHistoryOperation,
} from "./history-contract.js";
import type { HistoryEntry, HistoryPage } from "./history.js";
import { toWorkItemId, type WorkItemId } from "./types.js";

/** The slice of a work-items store the handler reads. */
export interface WorkItemHistoryStore {
  get(id: WorkItemId): Promise<unknown>;
  history?(id: WorkItemId): Promise<readonly HistoryEntry[]>;
  /** One page of versions, newest first, older than `cursor`; throws `HistoryCursorUnknownError` for a foreign cursor. */
  historyPage?(
    id: WorkItemId,
    options: { readonly cursor?: string | undefined; readonly limit: number }
  ): Promise<HistoryPage>;
}

/** The history query: `view=refs` asks for one page of refs, `cursor` (a commit) for the page older than it. */
export interface HistoryReadQuery {
  readonly view?: string | null | undefined;
  readonly cursor?: string | null | undefined;
}

/** A version as a ref: everything but `diff`. */
export function toHistoryRef(entry: HistoryEntry): HistoryRef {
  const { diff: _diff, ...ref } = entry;
  return { ...ref, cites: [...ref.cites], changed: [...ref.changed] };
}

/** Counts of versions by their actor's kind; a version with no kind counts under none. Counts only, no ids. */
function countActorKinds(entries: readonly { readonly actorKind?: string | undefined }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.actorKind !== undefined) counts[entry.actorKind] = (counts[entry.actorKind] ?? 0) + 1;
  }
  return counts;
}

/** The first refs page of an item's history (or the page older than `cursor`). */
export async function readHistoryRefsPage(
  store: Required<Pick<WorkItemHistoryStore, "historyPage">>,
  id: WorkItemId,
  cursor?: string
): Promise<HistoryRefsPage> {
  const page = await store.historyPage(id, { cursor, limit: HISTORY_REFS_PAGE });
  return { refs: page.entries.map(toHistoryRef), nextCursor: page.nextCursor };
}

export interface HistoryReadLog {
  readonly event: "work.items.history_read";
  readonly status: 200 | 400 | 404 | 503;
  readonly outcome: "success" | "refused" | "error";
  readonly versionCount?: number;
  readonly reasonCount?: number;
  /** Counts of the returned versions by actor kind (task.0133); counts only, never ids. */
  readonly actorKinds?: Readonly<Record<string, number>>;
  readonly errorCode?: "not_found" | "history_unavailable" | "invalid_input";
  /** Set on a failed read so the route may warn with the error class. */
  readonly errorName?: string;
  /** Database error code (SQLSTATE) from the thrown error, when it carries one. */
  readonly dbCode?: string;
  /** First 300 chars of the thrown error's message, CR/LF collapsed. */
  readonly errorMessage?: string;
}

export interface WorkItemHistoryResult {
  readonly status: 200 | 400 | 404 | 503;
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

const refused = (message: string, path: string): WorkItemHistoryResult => ({
  status: 400,
  body: { error: "invalid input", errorCode: "invalid_input", issues: [{ path: [path], message }] },
  log: { event: EVENT, status: 400, outcome: "refused", errorCode: "invalid_input" },
});

const COMMIT = /^[0-9a-z]{1,64}$/;

export async function readWorkItemHistory(
  store: WorkItemHistoryStore,
  id: string,
  query: HistoryReadQuery = {}
): Promise<WorkItemHistoryResult> {
  const view = query.view ?? undefined;
  const cursor = query.cursor ?? undefined;
  if (view !== undefined && view !== "refs") return refused("view must be refs", "view");
  if (cursor !== undefined && view !== "refs") return refused("cursor needs view=refs", "cursor");
  if (cursor !== undefined && !COMMIT.test(cursor)) return refused("cursor must be a commit", "cursor");
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
    if (view === "refs") {
      if (!store.historyPage) throw new Error("work-item history pages are not available");
      let page: HistoryRefsPage;
      try {
        page = await readHistoryRefsPage({ historyPage: store.historyPage.bind(store) }, itemId, cursor);
      } catch (error) {
        if ((error as Error | undefined)?.name === "HistoryCursorUnknownError")
          return refused("cursor is not a version of this item", "cursor");
        throw error;
      }
      return {
        status: 200,
        body: page,
        log: {
          event: EVENT,
          status: 200,
          outcome: "success",
          versionCount: page.refs.length,
          reasonCount: page.refs.filter((v) => v.reason !== null).length,
          actorKinds: countActorKinds(page.refs),
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
        actorKinds: countActorKinds(items),
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
