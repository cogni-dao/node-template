// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchGraph`
 * Purpose: This node's transport for the package `useKnowledgeGraph`: GET /api/v1/knowledge/graph, the whole projected graph at one store revision.
 * Scope: Browser fetch only. Graph state, revalidation, filtering and highlighting live in `@cogni/knowledge-base-ui/knowledge` (task.0059).
 * Invariants: Same-origin cookie credentials, never a Bearer header. The package passes the cached revision's entity tag; it is sent as If-None-Match and a 304 resolves `null` (no body downloaded or parsed). `cache: "no-store"`: revalidation is explicit, never the browser cache. Failures carry the HTTP `status`.
 * Side-effects: IO
 * @internal
 */

import {
  type KnowledgeGraphResponse,
  KnowledgeGraphResponseSchema,
} from "@cogni/knowledge-store/contracts";

import { KnowledgeReadError } from "./fetchBrowse";

export async function fetchGraph(
  signal: AbortSignal,
  ifNoneMatch?: string
): Promise<KnowledgeGraphResponse | null> {
  const response = await fetch("/api/v1/knowledge/graph", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(ifNoneMatch ? { headers: { "If-None-Match": ifNoneMatch } } : {}),
  });
  if (response.status === 304) return null;
  if (!response.ok)
    throw new KnowledgeReadError(
      `Knowledge graph failed (HTTP ${response.status})`,
      response.status
    );
  return KnowledgeGraphResponseSchema.parse(await response.json());
}
