// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/metrics/page`
 * Purpose: Metrics route (story.0039): goals, their KPIs and the metrics that serve each KPI. Server auth gate plus one SSR seed of the goal read.
 * Scope: Auth check and one `loadGoalsProgress()` seed, parsed with the metrics contract. A failed or unconfigured read degrades to the client fetch, never a 500. Renders no Metrics markup: the package owns the view.
 * Invariants: Protected route; the seed has the exact wire shape of `GET /api/v1/metrics/goals`.
 * Side-effects: IO (goal progress read)
 * Links: ./view.tsx, app/src/app/_facades/metrics.server.ts
 * @public
 */

import { GoalsProgressSchema } from "@cogni-dao/metrics/contracts";
import { redirect } from "next/navigation";

import { loadGoalsProgress } from "@/app/_facades/metrics.server";
import { getServerSessionUser } from "@/lib/auth/server";
import { MetricsView } from "./view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function MetricsPage() {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }
  let seed: unknown;
  try {
    seed = await loadGoalsProgress();
  } catch {
    seed = undefined;
  }
  return <MetricsView initialData={GoalsProgressSchema.safeParse(seed).data} />;
}
