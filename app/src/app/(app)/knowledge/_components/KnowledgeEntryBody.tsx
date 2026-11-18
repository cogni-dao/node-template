// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeEntryBody`
 * Purpose: The one body of a knowledge entry below its header: a goal's board, a
 *   metric's chart and brief, a hypothesis's KPI evidence, then the entry fields.
 *   The `/knowledge/[id]` page and the slide-over sheet both render it, so the
 *   two views never drift (task.0125).
 * Scope: Presentation over an already-fetched entry; the evidence mounts read their own data.
 * @internal
 */

"use client";

import type { KnowledgeRow } from "@cogni/node-contracts";
import type { MetricService } from "@cogni-dao/metrics";
import type { ReactElement } from "react";

import {
  KnowledgeGoalsBoard,
  KnowledgeKpiEvidence,
  KnowledgeMetricEvidence,
} from "./GoalsMount";
import { KnowledgeEntryFields } from "./KnowledgeEntryFields";

export type KnowledgeEntry = KnowledgeRow & {
  kpis?: Awaited<ReturnType<MetricService["bindings"]>>;
};

export function KnowledgeEntryBody({
  item,
}: {
  readonly item: KnowledgeEntry;
}): ReactElement {
  return (
    <>
      {item.entryType === "goal" && <KnowledgeGoalsBoard goalId={item.id} />}
      {item.metricSpec && <KnowledgeMetricEvidence id={item.id} />}
      {item.entryType === "hypothesis" && (
        <KnowledgeKpiEvidence kpiBindings={item.kpiBindings} kpis={item.kpis} />
      )}
      <div className="mt-2">
        <KnowledgeEntryFields item={item} />
      </div>
    </>
  );
}
