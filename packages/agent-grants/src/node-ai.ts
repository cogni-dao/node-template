// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/node-ai`
 * Purpose: The admin page's view of "This node's AI": each internal principal, its plain-language name and blurb, and
 *   its jobs with the live Allow state. Pure; the node supplies the catalog-derived jobs and the live role list.
 * Scope: Copy table (defaults a node may override) and the view builder. No I/O, no routes.
 * Invariants:
 *   - TOKENLESS_COPY: copy and labels hold no token, id, key, scope string or API path.
 *   - Jobs come from the tool contracts (`requires.label`, `requires.risk`); a scope with no label is skipped, never shown raw.
 *   - A principal with no copy entry gets a neutral name; the slug is never shown as the name.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import type {
  JobRisk,
  NodeAiJobView,
  NodeAiView,
  ToolRequires,
} from "./types";

export interface NodeAiCopy {
  readonly name: string;
  readonly blurb: string;
}

/** Default names for the seeded node AI. A node may pass its own table. */
export const NODE_AI_COPY: Readonly<Record<string, NodeAiCopy>> = {
  "node-ai": {
    name: "General assistant",
    blurb: "Answers questions and works with this node's notes and schedules.",
  },
  prioritizer: {
    name: "Priority scorer",
    blurb: "Keeps work-item priority scores up to date against your goals.",
  },
};

const FALLBACK_COPY: NodeAiCopy = {
  name: "Node assistant",
  blurb: "An assistant that works for this node.",
};

const RISK_ORDER: Record<JobRisk, number> = { high: 0, medium: 1, low: 2 };

export function buildNodeAiView(input: {
  /** principal slug -> the `requires` of every tool its graphs list (duplicates allowed). */
  readonly jobsByPrincipal: Readonly<Record<string, readonly ToolRequires[]>>;
  /** Live role rows: principal slug and scope. */
  readonly liveRoles: ReadonlyArray<{ principalSlug: string; scope: string }>;
  readonly copy?: Readonly<Record<string, NodeAiCopy>>;
}): NodeAiView[] {
  const copy = input.copy ?? NODE_AI_COPY;
  const live = new Set(input.liveRoles.map((r) => `${r.principalSlug}\u0000${r.scope}`));
  const views: NodeAiView[] = [];
  for (const slug of Object.keys(input.jobsByPrincipal).sort()) {
    const byScope = new Map<string, ToolRequires>();
    for (const requires of input.jobsByPrincipal[slug] ?? []) {
      if (requires.label && !byScope.has(requires.scope))
        byScope.set(requires.scope, requires);
    }
    const jobs: NodeAiJobView[] = [...byScope.values()]
      .map((r) => ({
        scope: r.scope,
        label: r.label as string,
        risk: r.risk ?? "medium",
        allowed: live.has(`${slug}\u0000${r.scope}`),
      }))
      .sort(
        (a, b) =>
          RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.label.localeCompare(b.label)
      );
    if (jobs.length === 0) continue;
    const text = copy[slug] ?? FALLBACK_COPY;
    views.push({ principal: slug, name: text.name, blurb: text.blurb, jobs });
  }
  return views;
}
