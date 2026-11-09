// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/board`
 * Purpose: Bounded board read: one first page of summaries per visible status column, with cursors that continue each column (task.0055).
 * Scope: Pure composition over an injected `listSummaries`; no I/O of its own. The node route supplies auth and the facade.
 * Invariants:
 *   - BOUNDED_BOARD: at most one `listSummaries` call per distinct visible status (≤ the lifecycle status set), each capped at `perColumn` ≤ `WORK_SUMMARY_PAGE_MAX` rows. Nothing walks a cursor.
 *   - COLUMN_CURSOR_IDENTITY: a column page is read with the exact query a later `/summaries?statuses=<status>&…&cursor=` request would build, so its `endCursor` is valid for that request.
 *   - ONE_REQUEST_BUDGET: one admission deadline (`WORK_BOARD_READ_BUDGET_MS`) and one rows-scanned budget cover the whole board, not each column. A column the budget does not reach returns `state: "not_started"` with no items and no cursor; a text column cut by the deadline returns its matches with a continuation.
 *   - POOL_SAFETY: the deadline only gates admission (before each column and each text batch). It never shortens a native query timeout, which alone can retire the shared reader pool.
 *   - ABORT_BETWEEN_COLUMNS: an aborted signal stops the board before its next column read; no further reads are issued for a request nobody awaits.
 *   - ONE_NATIVE_READ: without text, a supplied `listColumns` reads every column in ONE store call (Doltgres: one UNION ALL query, one reader slot, one native deadline); cursors are identical to the per-column path.
 *   - SEQUENTIAL_READS: text boards (and stores without `listColumns`) read columns one after another, each passed the request's shared deadline; the template's reader pool is width one, so concurrent calls would only queue and spend the deadline waiting. Sequential reads bound peak reader load to one query.
 * Side-effects: none (the injected reader performs the I/O)
 * Links: task.0055, packages/work-items/src/summary-query.ts
 * @public
 */

import { z } from "zod";

import { type WorkItemSummary, WorkItemSummarySchema } from "./contracts.js";
import {
  type ParsedWorkSummaryQuery,
  parseWorkSummarySearchParams,
  WORK_BOARD_COLUMN_PAGE,
  WORK_SUMMARY_PAGE_MAX,
  WORK_TEXT_SCAN_MAX_ROWS,
  type WorkSummaryIssue,
  type WorkSummaryPage,
  type WorkSummaryPageInfo,
  WorkSummaryPageInfoSchema,
  type WorkSummaryQuery,
  type WorkSummaryReadOptions,
} from "./summary-query.js";
import { VALID_TRANSITIONS } from "./transitions.js";

/** Every status a board column can show, in lifecycle order. */
export const WORK_BOARD_STATUSES: readonly string[] = [
  ...VALID_TRANSITIONS.keys(),
];

export const WORK_BOARD_COLUMN_STATES = ["loaded", "not_started"] as const;

export const WorkBoardColumnSchema = z.object({
  status: z.string(),
  /**
   * `not_started`: the request's shared budget ran out before this column was
   * read. It has no items and no cursor; its first page comes from
   * `/summaries?statuses=<status>&…` without a cursor.
   */
  state: z.enum(WORK_BOARD_COLUMN_STATES),
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
  options?: WorkSummaryReadOptions,
) => Promise<WorkSummaryPage>;

/** First pages of several status columns, as one composed read returns them. */
export interface WorkBoardColumnPages {
  readonly columns: ReadonlyArray<{
    readonly status: string;
    readonly items: WorkItemSummary[];
    readonly pageInfo: WorkSummaryPageInfo;
  }>;
  /** Native queries the read issued (1 for a composed board). */
  readonly queryCount: number;
}

/**
 * Reads the first page of every listed column in one composed store read
 * (`DoltgresWorkItemAdapter.listBoardColumns`). Each column's `endCursor` must
 * be the one `listSummaries({ ...query, statuses: [status], limit: perColumn })`
 * would issue. Not used for text queries.
 */
export type ListWorkBoardColumns = (
  query: WorkSummaryQuery,
  statuses: readonly string[],
  perColumn: number,
  options?: { readonly signal?: AbortSignal },
) => Promise<WorkBoardColumnPages>;

/**
 * Admission budget for one whole board request, shared by every column read:
 * no column (and no further text batch) starts after it. It never shortens a
 * native query, whose timeout stays the store's own.
 */
export const WORK_BOARD_READ_BUDGET_MS = 5_000;

export interface LoadWorkBoardOptions {
  /** Rows per column page; clamped to 1..`WORK_SUMMARY_PAGE_MAX`. Default `WORK_BOARD_COLUMN_PAGE`. */
  readonly perColumn?: number;
  /** Stops the board before its next column (and each column before its next batch). */
  readonly signal?: AbortSignal;
  /** One admission budget for the whole request. Default `WORK_BOARD_READ_BUDGET_MS`. */
  readonly budgetMs?: number;
  /** One rows-scanned budget for the whole request (text search). Default `WORK_TEXT_SCAN_MAX_ROWS`. */
  readonly maxScanRows?: number;
  /** Clock for tests. */
  readonly now?: () => number;
  /**
   * Composed reader: when present and the query has no text, all columns are
   * read in ONE call instead of one `listSummaries` per column.
   */
  readonly listColumns?: ListWorkBoardColumns;
}

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

const notStarted = (status: string): WorkBoardColumn => ({
  status,
  state: "not_started",
  items: [],
  pageInfo: { endCursor: null, hasMore: true, rowsScanned: 0 },
});

/**
 * Read the first page of every visible column. `statuses` is deduplicated and
 * order-preserving; the `statuses` and `cursor` of `query` are ignored, so the
 * caller's filters (types, projects, rank range, text, sort) apply to every
 * column. An unknown status throws a `RangeError` before any read.
 *
 * The whole request shares ONE admission deadline and ONE rows-scanned budget:
 * each read receives the deadline (admission for its further text batches) and
 * the remaining scan rows, and columns the budget does not reach come back
 * `not_started`. Worst case ≈ the budget plus one in-flight native batch. An aborted `signal` rejects with its
 * reason before the next column read.
 */
export async function loadWorkBoardColumns(
  listSummaries: ListWorkSummaries,
  query: WorkSummaryQuery,
  statuses: readonly string[],
  options: LoadWorkBoardOptions = {},
): Promise<WorkBoardColumns> {
  const visible = [...new Set(statuses)];
  const unknown = visible.filter(
    (status) => !WORK_BOARD_STATUSES.includes(status),
  );
  if (unknown.length) {
    throw new RangeError(`unknown work status: ${unknown.join(", ")}`);
  }
  if (options.listColumns && !query.text && visible.length > 0) {
    options.signal?.throwIfAborted();
    const base = workBoardColumnQuery(query, visible[0] as string, options.perColumn);
    const { statuses: _statuses, ...filters } = base;
    const composed = await options.listColumns(
      filters,
      visible,
      base.limit ?? WORK_BOARD_COLUMN_PAGE,
      options.signal ? { signal: options.signal } : undefined,
    );
    return {
      columns: visible.map((status): WorkBoardColumn => {
        const page = composed.columns.find((column) => column.status === status);
        if (!page) throw new Error(`composed board read omitted column ${status}`);
        return { status, state: "loaded", items: page.items, pageInfo: page.pageInfo };
      }),
    };
  }
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? WORK_BOARD_READ_BUDGET_MS);
  const scanBudget = Number(options.maxScanRows);
  let scanRowsLeft = Number.isFinite(scanBudget)
    ? Math.min(Math.trunc(scanBudget), WORK_TEXT_SCAN_MAX_ROWS)
    : WORK_TEXT_SCAN_MAX_ROWS;
  const columns: WorkBoardColumn[] = [];
  for (const status of visible) {
    options.signal?.throwIfAborted();
    if (now() >= deadline || scanRowsLeft < 1) {
      columns.push(notStarted(status));
      continue;
    }
    const page = await listSummaries(
      workBoardColumnQuery(query, status, options.perColumn),
      {
        deadline,
        maxScanRows: scanRowsLeft,
        ...(options.signal && { signal: options.signal }),
      },
    );
    scanRowsLeft -= page.pageInfo.rowsScanned ?? page.items.length;
    columns.push({
      status,
      state: "loaded",
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
