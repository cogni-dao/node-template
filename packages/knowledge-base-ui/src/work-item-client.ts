// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-item-client`
 * Purpose: The browser read contract for one work item's view (story.0085): the item envelope, an older page of artifact refs or
 *   history refs, a page of citation links and the expectations page, each parsed with the `@cogni/work-items` wire schemas.
 * Scope: GET only. A node supplies a base URL and, when its auth is not the page's cookie session, a `fetch` or request `init`
 *   carrying its credentials. Same shape as `createGoalsClient`.
 * Invariants:
 *   - ONE_WIRE_CONTRACT: every body is parsed by its owner's schema: `@cogni/work-items`, and `@cogni-dao/metrics/contracts`
 *     for expectations.
 *   - BOUNDED: each call reads one page; the server caps every page.
 *   - STATUS_ON_ERROR: a failed read throws `WorkItemReadError` with the HTTP `status`, so callers branch on status, never text.
 * Side-effects: IO (GET `${baseUrl}/work/items/{id}`, `/work/items/{id}/artifacts`, `/work/items/{id}/history`,
 *   `/work/items/{id}/expectations`, `/citations/{id}`)
 * Links: hub work-item-view-capability, packages/work-items/src/read-http.ts, ./goals/client.ts
 * @public
 */

import {
  type CitationLinksPage,
  CitationLinksPageSchema,
  type HistoryRefsPage,
  HistoryRefsPageSchema,
  type WorkItemArtifactRefsPage,
  WorkItemArtifactRefsPageSchema,
  type WorkItemInclude,
  type WorkItemReadDto,
  WorkItemReadDtoSchema,
} from "@cogni/work-items";
import { type WorkExpectationPage, WorkExpectationPageSchema } from "@cogni-dao/metrics/contracts";

import type { WorkMetric } from "./work-metrics.js";

/** Default mount of the node's v1 routes. */
export const WORK_ITEM_BASE_URL = "/api/v1";

/** Every part the view draws: links (Design roadmaps), artifacts and history. */
export const WORK_ITEM_VIEW_INCLUDES: readonly WorkItemInclude[] = ["links", "artifacts", "history"];

export type WorkItemResource = "item" | "artifacts" | "history" | "citations" | "expectations";

/** A failed read with its HTTP status, so callers branch on status, not message text. */
export class WorkItemReadError extends Error {
  constructor(
    readonly resource: WorkItemResource,
    readonly status: number
  ) {
    super(`work_item_${resource}_read_failed:${status}`);
    this.name = "WorkItemReadError";
  }
}

/** The HTTP status carried by a failed read, from any fetcher that attaches `status` to its error. */
export function workItemErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

export interface WorkItemClient {
  /** The item envelope. `include` defaults to every part the view draws; `artifact` adds that one artifact in full. */
  readonly fetchItem: (
    id: string,
    options?: { readonly include?: readonly WorkItemInclude[]; readonly artifact?: string | undefined },
    signal?: AbortSignal
  ) => Promise<WorkItemReadDto>;
  /** An older page of artifact refs: the refs view of the artifacts route. */
  readonly fetchArtifactRefs: (id: string, cursor: string, signal?: AbortSignal) => Promise<WorkItemArtifactRefsPage>;
  /** An older page of history refs: the refs view of the history route. */
  readonly fetchHistoryRefs: (id: string, cursor: string, signal?: AbortSignal) => Promise<HistoryRefsPage>;
  /** One page of an entity's citation links; no cursor is the first page. */
  readonly fetchCitationLinks: (id: string, cursor?: string, signal?: AbortSignal) => Promise<CitationLinksPage>;
  /** The item's recorded expectations and outcomes, one bounded server projection. */
  readonly fetchExpectations: (id: string, signal: AbortSignal, moves: readonly WorkMetric[]) => Promise<WorkExpectationPage>;
}

export interface WorkItemClientOptions {
  /** Where the node's v1 routes are mounted. Default `/api/v1`. */
  readonly baseUrl?: string;
  /** Replace `fetch` (for example to add an Authorization header). Default `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Extra request options; `cache` defaults to `no-store`, `credentials` to `same-origin`, and `signal` is always the caller's. */
  readonly init?: Omit<RequestInit, "signal" | "method">;
}

export function createWorkItemClient(options: WorkItemClientOptions = {}): WorkItemClient {
  const base = (options.baseUrl ?? WORK_ITEM_BASE_URL).replace(/\/+$/, "");
  const read = async (resource: WorkItemResource, path: string, signal: AbortSignal | undefined): Promise<unknown> => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const response = await doFetch(`${base}${path}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      ...options.init,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new WorkItemReadError(resource, response.status);
    return response.json();
  };
  const item = (id: string) => `/work/items/${encodeURIComponent(id)}`;
  const refs = (path: string, cursor: string) => `${path}?view=refs&cursor=${encodeURIComponent(cursor)}`;
  return {
    async fetchItem(id, { include = WORK_ITEM_VIEW_INCLUDES, artifact } = {}, signal) {
      const params = new URLSearchParams();
      if (include.length) params.set("include", include.join(","));
      if (artifact) params.set("artifact", artifact);
      const query = params.toString();
      return WorkItemReadDtoSchema.parse(await read("item", `${item(id)}${query ? `?${query}` : ""}`, signal));
    },
    async fetchArtifactRefs(id, cursor, signal) {
      return WorkItemArtifactRefsPageSchema.parse(await read("artifacts", refs(`${item(id)}/artifacts`, cursor), signal));
    },
    async fetchHistoryRefs(id, cursor, signal) {
      return HistoryRefsPageSchema.parse(await read("history", refs(`${item(id)}/history`, cursor), signal));
    },
    async fetchCitationLinks(id, cursor, signal) {
      const suffix = cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return CitationLinksPageSchema.parse(await read("citations", `/citations/${encodeURIComponent(id)}${suffix}`, signal));
    },
    async fetchExpectations(id, signal) {
      return WorkExpectationPageSchema.parse(await read("expectations", `${item(id)}/expectations`, signal));
    },
  };
}
