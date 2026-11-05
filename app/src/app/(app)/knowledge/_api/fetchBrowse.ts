// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Bounded wire schemas and cache identities shared by SSR seeds and client reads. */
import {
  KnowledgeBrowsePageSchema,
  type KnowledgeBrowseQuery,
  KnowledgeBrowseQuerySchema,
  type KnowledgeOverviewQuery,
  KnowledgeOverviewQuerySchema,
} from "@cogni/node-contracts";

export const browseKey = (query: KnowledgeBrowseQuery = {}) =>
  [
    "knowledge",
    query.search ? "search" : "browse",
    KnowledgeBrowseQuerySchema.parse(query),
  ] as const;
export const overviewKey = (query: KnowledgeOverviewQuery = {}) =>
  ["knowledge", "overview", KnowledgeOverviewQuerySchema.parse(query)] as const;

export async function fetchBrowse(
  query: KnowledgeBrowseQuery,
  signal?: AbortSignal,
  operation: "browse" | "overview" = "browse"
) {
  const params = new URLSearchParams();
  const parsed =
    operation === "browse"
      ? KnowledgeBrowseQuerySchema.parse(query)
      : KnowledgeOverviewQuerySchema.parse(query);
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value))
      for (const entry of value) params.append(key, entry);
    else if (value !== undefined) params.set(key, value);
  }
  const response = await fetch(`/api/v1/knowledge/${operation}?${params}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok)
    throw new Error(`Knowledge ${operation} failed (HTTP ${response.status})`);
  return KnowledgeBrowsePageSchema.parse(await response.json());
}
