// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@app/api/v1/ai/runs/[runId]`
 * Purpose: Read the immutable canonical result owned by the authenticated actor.
 * Scope: Existing bearer/session auth and run ownership; no execution or presentation repair.
 * Invariants: fail closed on missing, ambiguous, legacy or foreign result; no shared system scope.
 * Side-effects: IO (owned result read).
 * Links: https://cognidao.org/work/items/task.5340
 * @public
 */
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import { RunStreamParamsSchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ runId: string }>;
}

export const GET = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "ai.runs.result", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, user, routeParams) => {
    const params = RunStreamParamsSchema.safeParse(await routeParams?.params);
    if (!params.success) {
      return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
    }
    const result = await getContainer().managedExecution.readOwnedResult(
      params.data.runId,
      user.id
    );
    if (!result) {
      return NextResponse.json(
        { error: "result_unavailable" },
        { status: 404 }
      );
    }
    if (result.ok) {
      const parser = result.audience.graphId.startsWith("langgraph:")
        ? LANGGRAPH_CATALOG[result.audience.graphId.slice("langgraph:".length)]
            ?.parseResult
        : undefined;
      if (!parser) {
        return NextResponse.json(
          { error: "result_parser_missing" },
          { status: 503 }
        );
      }
      try {
        parser(result.structuredOutput);
      } catch {
        return NextResponse.json(
          { error: "result_unavailable" },
          { status: 409 }
        );
      }
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  }
);
