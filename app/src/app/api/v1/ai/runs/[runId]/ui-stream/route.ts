// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/runs/[runId]/ui-stream`
 * Purpose: Reconnect an authenticated chat client to a graph run using AI SDK UIMessageChunk SSE.
 * Scope: Ownership check, Redis replay subscription, and AiEvent-to-UIMessageChunk delivery only.
 * Invariants: Redis is ephemeral transport; terminal runs return 410 so clients reload Postgres.
 * Side-effects: IO (graph-run lookup, Redis subscription, HTTP stream)
 * Links: sibling raw /stream endpoint, /api/v1/ai/chat
 * @public
 */

import { toUserId, userActor } from "@cogni/ids";
import { RunStreamParamsSchema } from "@cogni/node-contracts";
import type { UIMessageChunk } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TerminalRunStatusSchema = z.enum([
  "success",
  "error",
  "skipped",
  "cancelled",
]);
const REDIS_CURSOR_PATTERN = /^\d+-\d+$/;

interface RouteParams {
  params: Promise<{ runId: string }>;
}

export const GET = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "ai.runs.ui-stream", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, routeParams) => {
    if (!routeParams) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const parsed = RunStreamParamsSchema.safeParse(await routeParams.params);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
    }
    const { runId } = parsed.data;
    const container = getContainer();
    const run = await container.graphRunRepository.getRunByRunId(
      userActor(toUserId(sessionUser.id)),
      runId
    );
    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    if (run.requestedBy !== sessionUser.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const terminalStatus = TerminalRunStatusSchema.safeParse(run.status);
    if (terminalStatus.success) {
      ctx.log.info({ runId, status: run.status }, "AI UI stream is terminal");
      return NextResponse.json(
        {
          error: "Run is terminal",
          terminalStatus: terminalStatus.data,
          ...(run.errorCode ? { errorCode: run.errorCode } : {}),
        },
        { status: 410 }
      );
    }

    const headerCursor = request.headers.get("last-event-id");
    const queryCursor = request.nextUrl.searchParams.get("cursor");
    const cursor = headerCursor ?? queryCursor ?? undefined;
    if (cursor !== undefined && !REDIS_CURSOR_PATTERN.test(cursor)) {
      return NextResponse.json({ error: "Invalid stream cursor" }, { status: 400 });
    }

    const textPartId = `run-${runId}`;
    const uiStream = createUIMessageStream({
      execute: async ({ writer }) => {
        let textOpen = false;
        let accumulatedText = "";
        let assistantFinal: string | undefined;

        const closeText = () => {
          if (textOpen) {
            writer.write({ type: "text-end", id: textPartId });
            textOpen = false;
          }
        };

        const writeCursor = (cursor: string) => {
          writer.write({
            type: "data-run-cursor",
            data: { cursor },
            transient: true,
          } as UIMessageChunk);
        };

        for await (const entry of container.runStream.subscribe(
          runId,
          request.signal,
          cursor
        )) {
          const event = entry.event;
          if (event.type === "usage_report") {
            writeCursor(entry.id);
          } else if (event.type === "text_delta") {
            if (!textOpen) {
              writer.write({ type: "text-start", id: textPartId });
              textOpen = true;
            }
            accumulatedText += event.delta;
            writer.write({
              type: "text-delta",
              id: textPartId,
              delta: event.delta,
            });
            writeCursor(entry.id);
          } else if (event.type === "assistant_final") {
            // Buffered until done reconciliation. Do not advance the durable
            // client cursor until the buffered content has been written.
            assistantFinal = event.content;
          } else if (event.type === "tool_call_start") {
            closeText();
            writer.write({
              type: "tool-input-start",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            } as UIMessageChunk);
            writer.write({
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.args,
            } as UIMessageChunk);
            writeCursor(entry.id);
          } else if (event.type === "tool_call_result") {
            writer.write({
              type: "tool-output-available",
              toolCallId: event.toolCallId,
              output: event.result,
            } as UIMessageChunk);
            writeCursor(entry.id);
          } else if (event.type === "status") {
            writer.write({
              type: "data-status",
              data: {
                phase: event.phase,
                ...(event.label ? { label: event.label } : {}),
              },
              transient: true,
            } as UIMessageChunk);
            writeCursor(entry.id);
          } else if (event.type === "error") {
            closeText();
            writer.write({ type: "error", errorText: event.error });
            writeCursor(entry.id);
          } else if (event.type === "done") {
            if (
              assistantFinal !== undefined &&
              assistantFinal.startsWith(accumulatedText) &&
              assistantFinal.length > accumulatedText.length
            ) {
              if (!textOpen) {
                writer.write({ type: "text-start", id: textPartId });
                textOpen = true;
              }
              writer.write({
                type: "text-delta",
                id: textPartId,
                delta: assistantFinal.slice(accumulatedText.length),
              });
            }
            closeText();
            writer.write({
              type: "finish",
              finishReason: (event.finishReason ?? "stop") as
                | "stop"
                | "length"
                | "tool-calls"
                | "content-filter"
                | "other"
                | "error",
            });
            writeCursor(entry.id);
          }
        }
        closeText();
      },
    });

    const response = createUIMessageStreamResponse({
      stream: uiStream,
      headers: { "X-Run-Id": runId },
    });
    return new NextResponse(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }
);
