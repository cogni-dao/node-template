// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc/provider/routing`
 * Purpose: The predicate a dispatcher uses to keep a graph off the LangGraph dev server.
 * Scope: Pure. The dispatcher itself stays in the node.
 * Invariants:
 *   - ROUTING_GUARD: a graph with a `program` or a `principal`, MCP tools, or any tool that is not `read_only` or that has `requires` needs source context, persistence, run hooks, the principal-bound guard and the shell audience, which only the in-process provider supplies. An unknown tool counts as needing it.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/shell-caller-run-claim
 * @public
 */

import type { CatalogBoundTool } from "@cogni/ai-tools";

interface RoutableEntry {
  readonly program?: string | undefined;
  readonly principal?: string | undefined;
  readonly mcpServerIds?: readonly string[] | undefined;
  readonly toolIds: readonly string[];
}

export function requiresInProcess(
  entry: RoutableEntry,
  toolBundle: readonly CatalogBoundTool[],
): boolean {
  if (entry.program !== undefined || entry.principal !== undefined) return true;
  if ((entry.mcpServerIds ?? []).length > 0) return true;
  return entry.toolIds.some((id) => {
    const bound = toolBundle.find((tool) => tool.contract.name === id);
    return (
      bound === undefined ||
      bound.contract.effect !== "read_only" ||
      bound.contract.requires !== undefined
    );
  });
}
