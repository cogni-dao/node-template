// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Pure URL/history policy for route-backed work-item selection. */

type SerializableSearchParams = Pick<URLSearchParams, "toString">;
type WorkRouter = {
  push(href: string, options: { scroll: boolean }): void;
  replace(href: string, options: { scroll: boolean }): void;
};

export function workListHref(searchParams: SerializableSearchParams): string {
  const query = searchParams.toString();
  return query ? `/work?${query}` : "/work";
}

export function workItemHref(
  id: string,
  searchParams: SerializableSearchParams
): string {
  const query = searchParams.toString();
  const path = `/work/${encodeURIComponent(id)}`;
  return query ? `${path}?${query}` : path;
}

export function openWorkItemPermalink(
  router: WorkRouter,
  id: string,
  searchParams: SerializableSearchParams
): void {
  router.push(workItemHref(id, searchParams), { scroll: false });
}

export function closeWorkItemPermalink(
  router: WorkRouter,
  searchParams: SerializableSearchParams
): void {
  router.replace(workListHref(searchParams), { scroll: false });
}
