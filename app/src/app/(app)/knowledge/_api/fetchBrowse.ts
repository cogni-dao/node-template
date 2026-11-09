// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchBrowse`
 * Purpose: This node's transport for the package Browse windows: GET /api/v1/knowledge/browse with the package-encoded parameters.
 * Scope: Browser fetch only. Request encoding, cache keys and windowing belong to `@cogni/knowledge-base-ui`.
 * Invariants: Same-origin cookie credentials, never a Bearer header. Responses parse through the store's bounded page schema; failures carry the HTTP `status`.
 * Side-effects: IO
 * Links: task.0059
 * @internal
 */

import {
  type KnowledgeBrowsePage,
  KnowledgeBrowsePageSchema,
} from "@cogni/node-contracts";

export class KnowledgeReadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "KnowledgeReadError";
    this.status = status;
  }
}

export async function fetchBrowse(
  params: URLSearchParams,
  signal: AbortSignal
): Promise<KnowledgeBrowsePage> {
  const response = await fetch(`/api/v1/knowledge/browse?${params}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new KnowledgeReadError(
      `Knowledge browse failed (HTTP ${response.status})`,
      response.status
    );
  return KnowledgeBrowsePageSchema.parse(await response.json());
}
