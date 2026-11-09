// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchGraph`
 * Purpose: This node's transport for the package `useKnowledgeGraph`: GET /api/v1/knowledge/graph, the whole projected graph at one store revision.
 * Scope: Browser fetch only. Graph state, filtering and highlighting live in `@cogni/knowledge-base-ui/knowledge` (task.0059).
 * Invariants: Same-origin cookie credentials, never a Bearer header. `cache: "no-cache"` makes the browser revalidate its cached copy with If-None-Match, so an unchanged revision is a 304 with no body. Failures carry the HTTP `status`.
 * Side-effects: IO
 * @internal
 */

import {
  type KnowledgeGraphResponse,
  KnowledgeGraphResponseSchema,
} from "@cogni/knowledge-store/contracts";

import { KnowledgeReadError } from "./fetchBrowse";

export async function fetchGraph(
  signal: AbortSignal
): Promise<KnowledgeGraphResponse> {
  const response = await fetch("/api/v1/knowledge/graph", {
    credentials: "same-origin",
    cache: "no-cache",
    signal,
  });
  if (!response.ok)
    throw new KnowledgeReadError(
      `Knowledge graph failed (HTTP ${response.status})`,
      response.status
    );
  return KnowledgeGraphResponseSchema.parse(await response.json());
}
