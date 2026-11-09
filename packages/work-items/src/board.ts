// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/board`
 * Purpose: Bounded board read: one first page of summaries per visible status column, with cursors that continue each column (task.0055).
 * Scope: Pure composition over an injected `listSummaries`; no I/O of its own. The node route supplies auth and the facade.
 * Invariants:
 *   - BOUNDED_BOARD: at most one `listSummaries` call per distinct visible status (≤ the lifecycle status set), each capped at `perColumn` ≤ `WORK_SUMMARY_PAGE_MAX` rows. Nothing walks a cursor.
 *   - COLUMN_CURSOR_IDENTITY: a column page is read with the exact query a later `/summaries?statuses=<status>&…&cursor=` request would build, so its `endCursor` is valid for that request.
 *   - ABORT_BETWEEN_COLUMNS: an aborted signal stops the board before its next column read; no further reads are issued for a request nobody awaits.
 *   - SEQUENTIAL_READS: columns are read one after another. Each `listSummaries` call owns its own read deadline that starts when it is issued; the template's reader pool is width one, so concurrent calls would only queue and spend their deadlines waiting. Sequential reads keep every call's deadline honest and bound peak reader load to one query.
 * Side-effects: none (the injected reader performs the I/O)
 * Links: task.0055, packages/work-items/src/summary-query.ts
 * @public
 */

import { z } from "zod";

import { WorkItemSummarySchema } from "./contracts.js";
import {
  type ParsedWorkSummaryQuery,
  parseWorkSummarySearchParams,
  WORK_BOARD_COLUMN_PAGE,
  WORK_SUMMARY_PAGE_MAX,
  type WorkSummaryIssue,
  type WorkSummaryPage,
  WorkSummaryPageInfoSchema,
  type WorkSummaryQuery,
} from "./summary-query.js";
import { VALID_TRANSITIONS } from "./transitions.js";

/** Every status a board column can show, in lifecycle order. */
export const WORK_BOARD_STATUSES: readonly string[] = [
  ...VALID_TRANSITIONS.keys(),
];

export const WorkBoardColumnSchema = z.object({
  status: z.string(),
  items: z.array(WorkItemSummarySchema),
  pageInfo: WorkSummaryPageInfoSchema,
});
export type WorkBoardColumn = z.infer<typeof WorkBoardColumnSchema>;

export const WorkBoardColumnsSchema = z.object({
  columns: z.array(WorkBoardColumnSchema),
});
export type WorkBoardColumns = z.infer<typeof WorkBoardColumnsSchema>;

/** The injected reader; in a node this is its facade over the summary store. */
export type ListWorkSummaries = (
  query: WorkSummaryQuery,
) => Promise<WorkSummaryPage>;

/**
 * The query one column's first page is read with, and the one a later column
 * page must repeat with `cursor` added.
 */
export function workBoardColumnQuery(
  query: WorkSummaryQuery,
  status: string,
  perColumn: number = WORK_BOARD_COLUMN_PAGE,
): WorkSummaryQuery {
  const { cursor: _cursor, ...rest } = query;
  return {
    ...rest,
    statuses: [status],
    limit: Math.min(
      Math.max(Math.trunc(perColumn), 1),
      WORK_SUMMARY_PAGE_MAX,
    ),
  };
}

/**
 * Read the first page of every visible column. `statuses` is deduplicated and
 * order-preserving; the `statuses` and `cursor` of `query` are ignored, so the
 * caller's filters (types, projects, rank range, text, sort) apply to every
 * column. An unknown status throws a `RangeError` before any read. An aborted
 * `signal` (for example the HTTP request's) stops before the next column read
 * and rejects with the signal's reason.
 */
export async function loadWorkBoardColumns(
  listSummaries: ListWorkSummaries,
  query: WorkSummaryQuery,
  statuses: readonly string[],
  perColumn: number = WORK_BOARD_COLUMN_PAGE,
  signal?: AbortSignal,
): Promise<WorkBoardColumns> {
  const visible = [...new Set(statuses)];
  const unknown = visible.filter(
    (status) => !WORK_BOARD_STATUSES.includes(status),
  );
  if (unknown.length) {
    throw new RangeError(`unknown work status: ${unknown.join(", ")}`);
  }
  const columns: WorkBoardColumn[] = [];
  for (const status of visible) {
    signal?.throwIfAborted();
    const page = await listSummaries(
      workBoardColumnQuery(query, status, perColumn),
    );
    columns.push({
      status,
      items: page.items,
      pageInfo: page.pageInfo,
    });
  }
  return { columns };
}

export type WorkBoardQueryParse =
  | {
      readonly ok: true;
      readonly query: ParsedWorkSummaryQuery;
      /** The visible columns, validated against the lifecycle status set. */
      readonly statuses: readonly string[];
    }
  | { readonly ok: false; readonly issues: readonly WorkSummaryIssue[] };

/**
 * Decode a board request: the summary query codec plus a required `statuses`
 * list naming the visible columns. `limit` and `cursor` do not apply to a board
 * read (the column budget is `WORK_BOARD_COLUMN_PAGE`).
 */
export function parseWorkBoardSearchParams(
  params: URLSearchParams,
): WorkBoardQueryParse {
  const parsed = parseWorkSummarySearchParams(params);
  if (!parsed.ok) return parsed;
  const statuses = [...new Set(parsed.query.statuses ?? [])];
  const unknown = statuses.filter(
    (status) => !WORK_BOARD_STATUSES.includes(status),
  );
  if (statuses.length === 0 || unknown.length) {
    return {
      ok: false,
      issues: [
        {
          code: "custom",
          path: ["statuses"],
          message: statuses.length
            ? `unknown work status: ${unknown.join(", ")}`
            : "statuses is required: name the visible board columns",
          input: parsed.query.statuses,
        },
      ],
    };
  }
  return { ok: true, query: parsed.query, statuses };
}
