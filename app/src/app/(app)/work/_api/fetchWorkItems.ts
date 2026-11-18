// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrappers for bounded work summary pages, the work board, item detail, and the item's older artifact
 *   and history ref pages (story.0058).
 * Scope: Calls summary, board and detail endpoints with type-safe contracts. Does not implement business logic.
 * Invariants:
 *   - Returns typed summary pages, board columns or details, or throws `WorkItemFetchError` carrying the HTTP status (the package hooks retry only 5xx and network failures)
 *   - BOUNDED_BOARD_READS: the only list reads are one `/work/summaries` page (table) and one `/work/board` request plus single column pages; nothing here walks cursors (task.0055)
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type { WorkItemsGetOutput, WorkItemSummariesListOutput } from "@cogni/node-contracts";
import type {
  HistoryRefsPage,
  WorkBoardColumns,
  WorkItemArtifactRefsPage,
  WorkSummaryPage,
} from "@cogni/work-items";

export class WorkItemFetchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkItemFetchError";
    this.status = status;
  }
}

export function isWorkItemNotFoundError(
  error: unknown,
): error is WorkItemFetchError {
  return error instanceof WorkItemFetchError && error.status === 404;
}

async function responseErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

/** Fetch one bounded server-filtered page. */
export async function fetchWorkItems(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<WorkItemSummariesListOutput> {
  const response = await fetch(`/api/v1/work/summaries?${params}`, {
    method: "GET",
    ...(signal && { signal }),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok)
    throw new WorkItemFetchError(
      await responseErrorMessage(response, `HTTP ${response.status}`),
      response.status,
    );
  return response.json() as Promise<WorkItemSummariesListOutput>;
}

/** Fetch the first page of every visible board column in one request. */
export async function fetchWorkBoard(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<WorkBoardColumns> {
  const response = await fetch(`/api/v1/work/board?${params}`, {
    method: "GET",
    ...(signal && { signal }),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok)
    throw new WorkItemFetchError(
      await responseErrorMessage(response, `HTTP ${response.status}`),
      response.status,
    );
  return response.json() as Promise<WorkBoardColumns>;
}

/** The detail view's envelope parts: page 1 of artifact and history refs (story.0058). */
export const WORK_ITEM_DETAIL_INCLUDE = "artifacts,history";

export async function fetchWorkItem(
  id: string,
  signal?: AbortSignal,
  options: { readonly include?: string; readonly artifact?: string | undefined } = {},
): Promise<WorkItemsGetOutput> {
  const params = new URLSearchParams();
  if (options.include) params.set("include", options.include);
  if (options.artifact) params.set("artifact", options.artifact);
  const query = params.toString();
  const response = await fetch(`/api/v1/work/items/${encodeURIComponent(id)}${query ? `?${query}` : ""}`, {
    method: "GET",
    ...(signal && { signal }),
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const message = await responseErrorMessage(
      response,
      `Failed to fetch work item (HTTP ${response.status})`,
    );
    throw new WorkItemFetchError(message, response.status);
  }
  return response.json() as Promise<WorkItemsGetOutput>;
}

async function fetchRefsPage<T>(path: string, cursor: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${path}?view=refs&cursor=${encodeURIComponent(cursor)}`, {
    method: "GET",
    ...(signal && { signal }),
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new WorkItemFetchError(
      await responseErrorMessage(response, `Failed to fetch refs (HTTP ${response.status})`),
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

/** An older page of an item's artifact refs: the refs view of the artifacts route. */
export function fetchArtifactRefs(id: string, cursor: string, signal?: AbortSignal): Promise<WorkItemArtifactRefsPage> {
  return fetchRefsPage(`/api/v1/work/items/${encodeURIComponent(id)}/artifacts`, cursor, signal);
}

/** An older page of an item's history refs: the refs view of the history route. */
export function fetchHistoryRefs(id: string, cursor: string, signal?: AbortSignal): Promise<HistoryRefsPage> {
  return fetchRefsPage(`/api/v1/work/items/${encodeURIComponent(id)}/history`, cursor, signal);
}
