// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/read-handlers`
 * Purpose: Framework-neutral request handlers for the bounded summary page and board reads, so every node route is auth + logging + one call (task.0055).
 * Scope: Decode with the shared codec, read through an injected `listSummaries`, validate the output schema, classify errors, and report telemetry. No HTTP framework, auth, logging or environment.
 * Invariants:
 *   - ONE_CODEC: requests decode with `parseWorkSummarySearchParams` / `parseWorkBoardSearchParams`; bodies encode with `WorkSummaryPageSchema` / `WorkBoardColumnsSchema`.
 *   - TYPED_ERRORS: invalid input → 400 `invalid_input` (with codec issues); a cursor error (name `InvalidCursorError`) → 400 `invalid_cursor`; a busy, capacity-held or unconfigured store (names `WorkItemsBusyError`, `WorkItemsCapacityError`, `WorkItemsBackendNotReadyError`, `DoltgresNotConfiguredError`) → 503 `backend_unavailable`; an aborted request → 499 `client_aborted` with no body; anything else → 500 `internal_error`. Cursor, 503 and 500 bodies are fixed strings.
 *   - TELEMETRY_IS_SAFE: telemetry carries counts, order, durations and rows scanned only, never item text or filters.
 * Side-effects: none (the injected reader performs the I/O)
 * Links: task.0055, packages/work-items/src/board.ts, packages/work-items/src/summary-query.ts
 * @public
 */

import {
  type ListWorkBoardColumns,
  type ListWorkSummaries,
  loadWorkBoardColumns,
  type LoadWorkBoardOptions,
  parseWorkBoardSearchParams,
  type WorkBoardColumns,
  WorkBoardColumnsSchema,
} from "./board.js";
import {
  normalizeWorkItemOrder,
  type WorkItemOrder,
} from "./query-order.js";
import {
  parseWorkSummarySearchParams,
  type WorkSummaryIssue,
  type WorkSummaryPage,
  WorkSummaryPageSchema,
  type WorkSummaryQuery,
} from "./summary-query.js";

/** Stable error codes; the values match the node observability registry. */
export const WORK_READ_ERROR_CODES = {
  INVALID_INPUT: "invalid_input",
  INVALID_CURSOR: "invalid_cursor",
  BACKEND_UNAVAILABLE: "backend_unavailable",
  INTERNAL_ERROR: "internal_error",
  CLIENT_ABORTED: "client_aborted",
} as const;
export type WorkReadErrorCode =
  (typeof WORK_READ_ERROR_CODES)[keyof typeof WORK_READ_ERROR_CODES];

/** Status 499: the client aborted; nobody reads the body. */
export const WORK_READ_CLIENT_CLOSED = 499;

export type WorkReadErrorBody =
  | {
      readonly error: "invalid input";
      readonly issues: readonly WorkSummaryIssue[];
    }
  | {
      readonly error: "invalid cursor";
      readonly code: "invalid_cursor";
      readonly message: string;
    }
  | { readonly error: string };

export interface WorkReadTelemetry {
  readonly status: number;
  readonly outcome: "success" | "error";
  readonly errorCode?: WorkReadErrorCode;
  /** Items returned (all columns for a board). */
  readonly count: number;
  readonly hasMore: boolean;
  /** Rows the store read (sum over columns for a board). */
  readonly rowsScanned: number;
  readonly sortBy?: WorkItemOrder["sortBy"];
  readonly sortDirection?: WorkItemOrder["sortDirection"];
  /** Board only: columns requested, columns the budget did not reach, each read's duration in order, native reads issued, and whether columns were composed into one read. */
  readonly columnCount?: number;
  readonly queryCount?: number;
  readonly readMode?: "composed" | "sequential";
  readonly notStartedCount?: number;
  readonly columnDurationsMs?: readonly number[];
}

export interface WorkReadResult<TBody> {
  readonly status: number;
  /** `null` only for an aborted request (499). */
  readonly body: TBody | WorkReadErrorBody | null;
  readonly telemetry: WorkReadTelemetry;
}

/** Fixed response texts: store and error internals never reach the client. */
const INVALID_CURSOR_MESSAGE = "restart pagination without a cursor";
const UNAVAILABLE_MESSAGE = "work items are temporarily unavailable; retry shortly";

const UNAVAILABLE_ERRORS = new Set([
  "WorkItemsBusyError",
  "WorkItemsCapacityError",
  "WorkItemsBackendNotReadyError",
  "DoltgresNotConfiguredError",
]);

/** Maps a reader failure to its HTTP class by error name (facades rethrow their own copies). */
export function classifyWorkReadError(
  error: unknown,
): "invalid_cursor" | "backend_unavailable" | undefined {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "InvalidCursorError") return "invalid_cursor";
  return typeof name === "string" && UNAVAILABLE_ERRORS.has(name)
    ? "backend_unavailable"
    : undefined;
}

function orderOf(query: WorkSummaryQuery): WorkItemOrder {
  return normalizeWorkItemOrder({
    ...(query.sortBy !== undefined && { sortBy: query.sortBy }),
    ...(query.sortDirection !== undefined && {
      sortDirection: query.sortDirection,
    }),
  });
}

interface Counts {
  readonly count: number;
  readonly hasMore: boolean;
  readonly rowsScanned: number;
}

function failure<TBody>(
  error: unknown,
  signal: AbortSignal | undefined,
  order: WorkItemOrder | undefined,
  extra: Partial<WorkReadTelemetry>,
): WorkReadResult<TBody> {
  const base = {
    count: 0,
    hasMore: false,
    rowsScanned: 0,
    ...order,
    ...extra,
  };
  if (signal?.aborted) {
    return {
      status: WORK_READ_CLIENT_CLOSED,
      body: null,
      telemetry: {
        ...base,
        status: WORK_READ_CLIENT_CLOSED,
        outcome: "error",
        errorCode: WORK_READ_ERROR_CODES.CLIENT_ABORTED,
      },
    };
  }
  const kind = classifyWorkReadError(error);
  if (kind === "invalid_cursor") {
    return {
      status: 400,
      body: {
        error: "invalid cursor",
        code: "invalid_cursor",
        message: INVALID_CURSOR_MESSAGE,
      },
      telemetry: {
        ...base,
        status: 400,
        outcome: "error",
        errorCode: WORK_READ_ERROR_CODES.INVALID_CURSOR,
      },
    };
  }
  if (kind === "backend_unavailable") {
    return {
      status: 503,
      body: { error: UNAVAILABLE_MESSAGE },
      telemetry: {
        ...base,
        status: 503,
        outcome: "error",
        errorCode: WORK_READ_ERROR_CODES.BACKEND_UNAVAILABLE,
      },
    };
  }
  return {
    status: 500,
    body: { error: "Internal server error" },
    telemetry: {
      ...base,
      status: 500,
      outcome: "error",
      errorCode: WORK_READ_ERROR_CODES.INTERNAL_ERROR,
    },
  };
}

function invalid<TBody>(
  issues: readonly WorkSummaryIssue[],
): WorkReadResult<TBody> {
  return {
    status: 400,
    body: { error: "invalid input", issues },
    telemetry: {
      status: 400,
      outcome: "error",
      errorCode: WORK_READ_ERROR_CODES.INVALID_INPUT,
      count: 0,
      hasMore: false,
      rowsScanned: 0,
    },
  };
}

function success<TBody>(
  body: TBody,
  order: WorkItemOrder,
  counts: Counts,
  extra: Partial<WorkReadTelemetry> = {},
): WorkReadResult<TBody> {
  return {
    status: 200,
    body,
    telemetry: { status: 200, outcome: "success", ...counts, ...order, ...extra },
  };
}

export interface WorkSummariesRequestOptions {
  readonly signal?: AbortSignal;
}

/** `GET …/work/summaries`: one bounded keyset page. */
export async function handleWorkSummariesRequest(
  params: URLSearchParams,
  listSummaries: ListWorkSummaries,
  options: WorkSummariesRequestOptions = {},
): Promise<WorkReadResult<WorkSummaryPage>> {
  const parsed = parseWorkSummarySearchParams(params);
  if (!parsed.ok) return invalid(parsed.issues);
  const order = orderOf(parsed.query);
  try {
    const page = WorkSummaryPageSchema.parse(
      await listSummaries(
        parsed.query,
        options.signal ? { signal: options.signal } : undefined,
      ),
    );
    return success(page, order, {
      count: page.items.length,
      hasMore: page.pageInfo.hasMore,
      rowsScanned: page.pageInfo.rowsScanned ?? page.items.length,
    });
  } catch (error) {
    return failure(error, options.signal, order, {});
  }
}

export type WorkBoardRequestOptions = Omit<LoadWorkBoardOptions, "now">;

/** `GET …/work/board`: the first page of every visible column under one budget. */
export async function handleWorkBoardRequest(
  params: URLSearchParams,
  listSummaries: ListWorkSummaries,
  options: WorkBoardRequestOptions = {},
): Promise<WorkReadResult<WorkBoardColumns>> {
  const parsed = parseWorkBoardSearchParams(params);
  if (!parsed.ok) return invalid(parsed.issues);
  const order = orderOf(parsed.query);
  const columnDurationsMs: number[] = [];
  let queryCount = 0;
  const timed: ListWorkSummaries = async (query, readOptions) => {
    const startedAt = performance.now();
    try {
      return await listSummaries(query, readOptions);
    } finally {
      columnDurationsMs.push(Math.round(performance.now() - startedAt));
      queryCount += 1;
    }
  };
  const listColumns = options.listColumns;
  const composed: ListWorkBoardColumns | undefined = listColumns
    ? async (...args) => {
        const startedAt = performance.now();
        let issued: number | undefined;
        try {
          const pages = await listColumns(...args);
          issued = pages.queryCount;
          return pages;
        } finally {
          columnDurationsMs.push(Math.round(performance.now() - startedAt));
          queryCount += issued ?? 1;
        }
      }
    : undefined;
  const boardTelemetry = () => ({
    columnCount: parsed.statuses.length,
    columnDurationsMs,
    queryCount,
    readMode:
      composed && !parsed.query.text
        ? ("composed" as const)
        : ("sequential" as const),
  });
  try {
    const result = WorkBoardColumnsSchema.parse(
      await loadWorkBoardColumns(timed, parsed.query, parsed.statuses, {
        ...options,
        ...(composed && { listColumns: composed }),
      }),
    );
    return success(
      result,
      order,
      {
        count: result.columns.reduce((n, c) => n + c.items.length, 0),
        hasMore: result.columns.some((c) => c.pageInfo.hasMore),
        rowsScanned: result.columns.reduce(
          (n, c) => n + (c.pageInfo.rowsScanned ?? c.items.length),
          0,
        ),
      },
      {
        ...boardTelemetry(),
        notStartedCount: result.columns.filter((c) => c.state === "not_started")
          .length,
      },
    );
  } catch (error) {
    return failure(error, options.signal, order, boardTelemetry());
  }
}
