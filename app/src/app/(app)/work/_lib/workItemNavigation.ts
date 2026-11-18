// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Pure URL/history policy for route-backed work-item selection. ITEM_SCOPED_PARAMS (`artifact`, `artifactsCursor`,
 * `historyCursor`, story.0058) belong to one open item: opening another item, closing it or editing the list drops them.
 */

type SerializableSearchParams = Pick<URLSearchParams, "toString">;
type WorkRouter = {
  push(href: string, options: { scroll: boolean }): void;
  replace(href: string, options: { scroll: boolean }): void;
};

interface WorkListState {
  readonly type: readonly string[];
  readonly status: readonly string[];
  readonly sort: string | null;
  readonly query: string;
  readonly rankRange?: readonly [number | undefined, number | undefined];
}

/** URL parameters that belong to one open item (story.0058): its selected artifact and its older ref pages. */
export const ITEM_SCOPED_PARAMS = ["artifact", "artifactsCursor", "historyCursor"] as const;
export type ItemScopedParam = (typeof ITEM_SCOPED_PARAMS)[number];

/** The same parameters without the ones that belong to the open item; another item, or none, never inherits them. */
export function withoutItemScopedParams(searchParams: SerializableSearchParams): URLSearchParams {
  const params = new URLSearchParams(searchParams.toString());
  for (const key of ITEM_SCOPED_PARAMS) params.delete(key);
  return params;
}

/** The open item's href with one item-scoped parameter set (a value) or cleared (null). */
export function itemScopedHref(
  id: string,
  searchParams: SerializableSearchParams,
  key: ItemScopedParam,
  value: string | null,
): string {
  const params = new URLSearchParams(searchParams.toString());
  if (value === null) params.delete(key);
  else params.set(key, value);
  return workItemHref(id, params);
}

export function workListHref(searchParams: SerializableSearchParams): string {
  const query = searchParams.toString();
  return query ? `/work?${query}` : "/work";
}

export function workItemHref(
  id: string,
  searchParams: SerializableSearchParams,
): string {
  const query = searchParams.toString();
  const path = `/work/items/${encodeURIComponent(id)}`;
  return query ? `${path}?${query}` : path;
}

function setListParam(
  params: URLSearchParams,
  key: string,
  values: readonly string[],
): void {
  params.delete(key);
  if (values.length > 0) params.set(key, values.join(","));
}

/** Updates owned list controls without discarding unrelated URL-backed state. */
export function workViewHref(
  selectedItemId: string | undefined,
  searchParams: SerializableSearchParams,
  state: WorkListState,
): string {
  const params = withoutItemScopedParams(searchParams);
  params.delete("cursor");
  setListParam(params, "type", state.type);
  setListParam(params, "status", state.status);
  if (state.status.length === 0) params.set("status", "all");
  // The Project filter was replaced by the Goal column (task.0112); an old link's value is dropped on the next edit.
  params.delete("project");
  params.delete("sort");
  if (state.sort) params.set("sort", state.sort);
  params.delete("q");
  if (state.query) params.set("q", state.query);
  if (state.rankRange !== undefined) {
    for (const [index, key] of ["rankMin", "rankMax"].entries()) {
      const value = state.rankRange[index];
      params.set(key, value === undefined ? "" : String(value));
    }
  }
  return selectedItemId
    ? workItemHref(selectedItemId, params)
    : workListHref(params);
}

export function openWorkItemPermalink(
  router: WorkRouter,
  id: string,
  searchParams: SerializableSearchParams,
): void {
  router.push(workItemHref(id, withoutItemScopedParams(searchParams)), { scroll: false });
}

export function closeWorkItemPermalink(
  router: WorkRouter,
  searchParams: SerializableSearchParams,
): void {
  router.replace(workListHref(withoutItemScopedParams(searchParams)), { scroll: false });
}
