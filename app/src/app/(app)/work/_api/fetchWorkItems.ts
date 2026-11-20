// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrappers for bounded work summary pages and the work board, and the one item-view read client
 *   (`workItemClient`, from the package, story.0085) that every host reads the item through.
 * Scope: Calls summary, board and detail endpoints with type-safe contracts. Does not implement business logic.
 * Invariants:
 *   - Returns typed summary pages, board columns or details, or throws `WorkItemFetchError` carrying the HTTP status (the package hooks retry only 5xx and network failures)
 *   - BOUNDED_BOARD_READS: the only list reads are one `/work/summaries` page (table) and one `/work/board` request plus single column pages; nothing here walks cursors (task.0055)
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import { createWorkItemClient } from "@cogni/knowledge-base-ui/work-item";
import type { WorkItemSummariesListOutput } from "@cogni/node-contracts";
import type { WorkBoardColumns, WorkSummaryPage } from "@cogni/work-items";

export class WorkItemFetchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkItemFetchError";
    this.status = status;
  }
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

/**
 * The item read for the item view (story.0085): the package client, every part the view draws (`WORK_ITEM_VIEW_INCLUDES`),
 * parsed with the work-items schema. A failed read throws `WorkItemReadError` with the HTTP `status`.
 */
export const workItemClient = createWorkItemClient();

