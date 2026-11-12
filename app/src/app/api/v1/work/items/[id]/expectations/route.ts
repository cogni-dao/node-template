// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { KpiBindingsSchema } from "@cogni-dao/metrics/contracts";
import { NextResponse } from "next/server";
import { getWorkItem } from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{ params: Promise<{ id: string }> }>(
  { routeId: "work.expectations.get", auth: { mode: "required", getSessionUser } },
  async (_ctx, request, user, context) => {
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!context) throw new Error("context required");
    const { id } = await context.params;
    const container = getContainer();
    if (!container.knowledgeStorePort?.readWorkEdo)
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    const [itemResult, pageResult] = await Promise.allSettled([
      getWorkItem(id),
      container.knowledgeStorePort.readWorkEdo(id, request.signal),
    ]);
    if (itemResult.status !== "fulfilled" || pageResult.status !== "fulfilled")
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    const item = itemResult.value,
      page = pageResult.value;
    if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
    const entries = page.items.map(({ hypothesis, outcomes, truncated }) => ({
      hypothesis,
      outcomes,
      truncated,
      parsed: KpiBindingsSchema.safeParse(hypothesis.kpiBindings ?? []),
    }));
    const matched = entries.flatMap((entry) =>
      entry.parsed.success
        ? entry.parsed.data.filter((binding) =>
            item.moves?.some(
              (move) =>
                move.metricId === binding.metricId &&
                move.baselineObservationId !== null &&
                move.baselineObservationId === binding.baselineObservationId,
            ),
          )
        : [],
    );
    const assessments =
      container.goalMetrics && matched.length
        ? await container.goalMetrics.predictionBatch(matched).catch(() => [])
        : [];
    let cursor = 0;
    const items = entries.map(({ hypothesis, outcomes, truncated, parsed }) => ({
      id: hypothesis.id,
      title: hypothesis.title,
      content: hypothesis.content,
      outcomes,
      truncated,
      predictions: parsed.success
        ? parsed.data.map((binding) => {
            const same = item.moves?.some(
              (move) =>
                move.metricId === binding.metricId &&
                move.baselineObservationId !== null &&
                move.baselineObservationId === binding.baselineObservationId,
            );
            const assessment = same ? assessments[cursor++]?.assessment : undefined;
            const observed = assessment
              ? [
                  assessment.status,
                  assessment.value == null ? null : `${assessment.value} ${assessment.unit}`,
                  assessment.observationId,
                  assessment.reason,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "unresolved";
            return {
              metricId: binding.metricId,
              expected: `${binding.comparator} ${binding.target.value} ${binding.target.unit}`,
              observed: same ? observed : "unresolved (metric or baseline mismatch)",
            };
          })
        : [{ metricId: "", expected: "invalid binding", observed: "unresolved" }],
    }));
    return NextResponse.json(
      { items, truncated: page.truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
