// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/GoalsMount`
 * Purpose: This node's mount of the Goals capability published by `@cogni/knowledge-base-ui/goals` (task.0062): the goal entry page's board, the measurement evidence and the hypothesis KPI evidence. The Goals tab moved to the top-level Metrics page (`(app)/metrics`, story.0039).
 * Scope: Composition only. The package owns the board, chart, range control, evidence views, read client and poll contract. The node supplies one host (`NODE_GOALS_HOST`: the package-default cookie-session client at `/api/v1/metrics`, Next's `Link` for client navigation) and the `?observation=` URL value. A fork that needs another client, `init`, `queryKeyPrefix` or `hrefs` changes only `NODE_GOALS_HOST`.
 * Invariants: ONE_CACHE_ENTRY (every component here sits under `KnowledgeGoalsProvider`, so they share one client and one key prefix with the Metrics page); no Goals markup, formatting or fetching lives in the app.
 * Side-effects: none beyond the package's GET reads
 * Links: task.0062, packages/knowledge-base-ui/AGENTS.md
 * @internal
 */

"use client";

import {
  GoalsBoard,
  type GoalsBoardProps,
  type GoalsHostOptions,
  GoalsProvider,
  KpiEvidence,
  type KpiEvidenceProps,
  MetricEvidence,
} from "@cogni/knowledge-base-ui/goals";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

/** The node's single Goals host. Module-level so every provider shares the same identity. */
export const NODE_GOALS_HOST: GoalsHostOptions = { LinkComponent: Link };

export function KnowledgeGoalsProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  return <GoalsProvider {...NODE_GOALS_HOST}>{children}</GoalsProvider>;
}

export function KnowledgeGoalsBoard(props: GoalsBoardProps) {
  return (
    <KnowledgeGoalsProvider>
      <GoalsBoard {...props} />
    </KnowledgeGoalsProvider>
  );
}

/** Evidence for a metric entry; the linked reading comes from `?observation=`. */
export function KnowledgeMetricEvidence({ id }: { readonly id: string }) {
  return (
    <KnowledgeGoalsProvider>
      <MetricEvidence
        id={id}
        observationId={useSearchParams().get("observation")}
      />
    </KnowledgeGoalsProvider>
  );
}

/** A hypothesis' KPI evidence, from its stored bindings and the subject projection. */
export function KnowledgeKpiEvidence(props: KpiEvidenceProps) {
  return (
    <KnowledgeGoalsProvider>
      <KpiEvidence {...props} />
    </KnowledgeGoalsProvider>
  );
}
