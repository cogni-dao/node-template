// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals` (kpi-evidence)
 * Purpose: The "KPI evidence" panel of a hypothesis page: one block per ordered KPI binding with its metric link, comparator and target, the latest reading with its unit and view state, and a link to that immutable observation.
 * Scope: Presentational. The node passes the entry's raw `kpiBindings` and the `kpis` its subject projection returned (one result per ordered binding); links come from the injected `hrefs` and `LinkComponent`. No fetching.
 * Invariants: UNKNOWN_IS_NOT_ZERO (no reading prints "Unknown", never 0); BINDING_ORDER (result `i` belongs to binding `i`); STATUS_NEVER_COLOR_ONLY (state is text); an invalid binding list renders nothing rather than guessed rows.
 * Side-effects: none
 * Links: ./context.tsx, packages/metrics/src/contracts.ts (KpiBindingsSchema)
 * @public
 */

"use client";

import { KpiBindingsSchema } from "@cogni-dao/metrics/contracts";

import { useGoalsHost } from "./context.js";
import { COMPARATOR_SYMBOL } from "./presentation.js";

/** The reading a subject projection returns for one binding. */
export interface KpiEvidenceReading {
  readonly observation?:
    | {
        readonly id: string;
        readonly value: number | null;
        readonly unit: string;
      }
    | null
    | undefined;
  readonly viewState?: string | undefined;
}

export interface KpiEvidenceProps {
  /** The entry's stored bindings, validated here with `KpiBindingsSchema`. */
  readonly kpiBindings: unknown;
  /** One result per ordered binding, from `GET /api/v1/metrics/subjects/{id}`. */
  readonly kpis?: readonly KpiEvidenceReading[] | null | undefined;
}

export function KpiEvidence({ kpiBindings, kpis }: KpiEvidenceProps) {
  const { hrefs, Link } = useGoalsHost();
  const bindings = KpiBindingsSchema.safeParse(kpiBindings).data ?? [];
  if (bindings.length === 0) return null;
  return (
    <section
      className="space-y-2 rounded border p-4 text-sm"
      aria-label="Goal KPI measurements"
    >
      <h2 className="font-medium">KPI evidence</h2>
      {bindings.map((binding, index) => {
        const reading = kpis?.[index];
        const observation = reading?.observation;
        return (
          <div key={`${binding.metricId}:${index}`} className="space-y-1">
            <p>
              <Link className="underline" href={hrefs.metric(binding.metricId)}>
                {binding.metricId}
              </Link>{" "}
              · target {COMPARATOR_SYMBOL[binding.comparator]}{" "}
              {binding.target.value} {binding.target.unit}
              {binding.evaluationAt ? ` · evaluate ${binding.evaluationAt}` : ""}
            </p>
            <p>
              {observation?.value ?? "Unknown"}{" "}
              {observation?.unit ?? binding.target.unit} ·{" "}
              {reading?.viewState ?? "unavailable"}
            </p>
            {observation && (
              <Link
                className="block break-all text-xs underline"
                href={`${hrefs.observation(binding.metricId, observation.id)}#observation-${observation.id}`}
              >
                Observation {observation.id}
              </Link>
            )}
          </div>
        );
      })}
    </section>
  );
}
