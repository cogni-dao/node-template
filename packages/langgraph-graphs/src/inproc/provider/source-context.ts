// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc/provider/source-context`
 * Purpose: Resolve the node's mission and governing index for a `program` run.
 * Scope: Pure over its arguments; the node supplies its id, origin, mission, build sha and knowledge reader.
 * Invariants:
 *   - FAIL_CLOSED_WHEN_REQUIRED: a required context with no mission, origin or knowledge reader throws `node_source_context_unavailable`
 *   - ONE_LOADER: every node resolves its context here, with no stricter loader and no hard-coded entry id
 * Side-effects: IO (the knowledge reader)
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design
 * @public
 */

import type { SourceContext } from "./types";

type GoverningIndex = NonNullable<SourceContext["governingIndex"]>;

export async function resolveNodeSourceContext(
  required: boolean,
  nodeId: string,
  origin: string | undefined,
  mission: string | null | undefined,
  buildSha: string | undefined,
  knowledge: { listGoverningIndex: () => Promise<GoverningIndex> } | undefined,
): Promise<SourceContext> {
  if (required && (!mission || !origin || !knowledge)) {
    throw new Error("node_source_context_unavailable");
  }
  return {
    nodeId,
    ...(origin ? { origin } : {}),
    ...(mission
      ? {
          mission: {
            content: mission,
            sourceRef: ".cogni/repo-spec.yaml",
            buildSha: buildSha ?? null,
          },
        }
      : {}),
    governingIndex: origin && knowledge ? await knowledge.listGoverningIndex() : [],
  };
}
