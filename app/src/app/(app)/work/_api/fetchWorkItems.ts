// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrapper for work items list.
 * Scope: Calls /api/v1/work/items with type-safe contract. Does not implement business logic.
 * Invariants: Returns typed WorkItemsListOutput or throws
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type { WorkItemDto, WorkItemsListOutput } from "@cogni/node-contracts";

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

/** Load every cursor page before client-side sorting, filtering and pagination. */
export async function fetchWorkItems(): Promise<WorkItemsListOutput> {
  const items = new Map<string, WorkItemDto>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const params = new URLSearchParams({ limit: "500" });
    if (cursor !== undefined) params.set("cursor", cursor);
    const response = await fetch(`/api/v1/work/items?${params}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        await responseErrorMessage(response, `HTTP ${response.status}`),
      );
    }

    const page = (await response.json()) as WorkItemsListOutput;
    for (const item of page.items) items.set(item.id, item);

    const hasMore = page.pageInfo?.hasMore ?? Boolean(page.nextCursor);
    if (!hasMore) {
      return {
        items: [...items.values()],
        pageInfo: { endCursor: null, hasMore: false },
      };
    }
    const nextCursor = page.pageInfo?.endCursor ?? page.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("Work-item pagination did not advance");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function fetchWorkItem(id: string): Promise<WorkItemDto> {
  const response = await fetch(`/api/v1/work/items/${encodeURIComponent(id)}`, {
    method: "GET",
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
  return response.json() as Promise<WorkItemDto>;
}
