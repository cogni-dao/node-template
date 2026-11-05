// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authenticated bounded graph overview; no bodies or citation read. */
import {
  KnowledgeOverviewPageSchema,
  KnowledgeOverviewQuerySchema,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "knowledge.overview", auth: { mode: "required", getSessionUser } },
  async (_ctx, request, sessionUser) => {
    if (!sessionUser)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const port = getContainer().knowledgeStorePort;
    if (!port)
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    const parsed = KnowledgeOverviewQuerySchema.safeParse(
      (() => {
        const params = new URL(request.url).searchParams;
        return {
          ...Object.fromEntries(params),
          ...Object.fromEntries(
            ["domains", "entryTypes", "sourceTypes"]
              .filter((key) => params.has(key))
              .map((key) => [key, params.getAll(key)])
          ),
        };
      })()
    );
    if (!parsed.success)
      return NextResponse.json({ error: "invalid query" }, { status: 400 });
    try {
      return NextResponse.json(
        KnowledgeOverviewPageSchema.parse(
          await port.overviewKnowledge(parsed.data)
        )
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "Invalid browse cursor" ||
          error.message === "Browse cursor does not match query")
      )
        return NextResponse.json({ error: error.message }, { status: 400 });
      throw error;
    }
  }
);
