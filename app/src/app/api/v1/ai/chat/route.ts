// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/chat`
 * Purpose: HTTP endpoint for chat API using AI SDK Data Stream Protocol with server-authoritative thread persistence.
 * Scope: Accepts user message string, loads thread from DB, starts graph workflow, pipes SSE from Redis via createUIMessageStream. Does not persist assistant messages (execution layer handles that). Does not implement business logic.
 * Invariants:
 *   - CLIENT_SENDS_USER_ONLY: client sends single message string; server loads authoritative thread from DB
 *   - OPTIMISTIC_APPEND: two-phase save (user before execute, assistant after pump) with expectedMessageCount guard
 *   - METADATA_ON_INSERT: thread metadata (model, graphName) saved on first persist only (expectedLen === 0)
 *   - Uses AI SDK createUIMessageStream (no custom SSE)
 *   - Per ASSISTANT_FINAL_REQUIRED: reconciles truncated text_delta events with assistant_final
 *   - Per STATUS_IS_EPHEMERAL: StatusEvent maps to transient data-status chunk, never persisted
 * Side-effects: IO (HTTP request/response, DB persistence)
 * Notes: P1 wire format — createUIMessageStream + createUIMessageStreamResponse (SSE). Pure pipe — no persistence accumulator.
 * Links: Uses ai.chat.v1 contract, completion.server facade, AI SDK streaming, ThreadPersistencePort
 * @public
 */

import { createHash } from "node:crypto";
import { isAiExecutionError, type ModelRef } from "@cogni/ai-core";
import { toUserId } from "@cogni/ids";
import { aiChatOperation, type ChatInput } from "@cogni/node-contracts";
import { ChatValidationError } from "@cogni/node-shared";
import type { UIMessage, UIMessageChunk } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
import { executionErrorToHttpStatus } from "@/app/_facades/ai/execution-error-mapper";
import { completionStream } from "@/app/_facades/ai/completion.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { isAccountsFeatureError } from "@/features/accounts/public";
import {
  redactSecretsInMessages,
  redactSecretsInText,
  uiMessagesToMessageDtos,
} from "@/features/ai/public.server";
import {
  isInsufficientCreditsPortError,
  isLlmError,
  ThreadConflictError,
} from "@/ports";
import {
  aiChatDuplicateTurnsTotal,
  aiChatPhaseDurationMs,
  aiChatStreamDurationMs,
  logRequestWarn,
  type RequestContext,
} from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ChatTurnEnvelope {
  readonly version: 1;
  /** SHA-256 of canonical redacted text, allowing retries after persistence. */
  readonly messageDigest: string;
  /** Server-authoritative ID used by Temporal, Redis, graph_runs, and reconnect. */
  readonly serverRunId: string;
  /** Optional untrusted client seed used only when deriving serverRunId. */
  readonly clientRunSeed?: string;
  readonly graphName: string;
  readonly modelRef: ModelRef;
}

class ChatTurnMismatchError extends Error {
  constructor(messageId: string) {
    super(`Chat turn ${messageId} was retried with a different envelope`);
    this.name = "ChatTurnMismatchError";
  }
}

function envelopeOf(message: UIMessage): ChatTurnEnvelope | undefined {
  const metadata = message.metadata as
    | { chatTurn?: ChatTurnEnvelope }
    | undefined;
  return metadata?.chatTurn;
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = (((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8) >>> 0)
    .toString(16)
    .slice(0, 1);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function assertSameTurn(
  existing: UIMessage,
  input: ChatInput,
  userId: string,
  stateKey: string
): ChatTurnEnvelope {
  const envelope = envelopeOf(existing);
  const expectedServerRunId = deriveServerRunId(
    userId,
    stateKey,
    existing.id,
    input.runId
  );
  const sameModel =
    envelope?.modelRef.providerKey === input.modelRef.providerKey &&
    envelope.modelRef.modelId === input.modelRef.modelId &&
    envelope.modelRef.connectionId === input.modelRef.connectionId;
  if (
    existing.role !== "user" ||
    envelope?.version !== 1 ||
    envelope.messageDigest !== messageDigest(input.message) ||
    envelope.serverRunId !== expectedServerRunId ||
    envelope.clientRunSeed !== input.runId ||
    envelope.graphName !== input.graphName ||
    !sameModel
  ) {
    throw new ChatTurnMismatchError(existing.id);
  }
  return envelope;
}

function messageDigest(message: string): string {
  return createHash("sha256")
    .update(redactSecretsInText(message), "utf8")
    .digest("hex");
}

function deriveServerRunId(
  userId: string,
  stateKey: string,
  messageId: string,
  clientRunSeed?: string
): string {
  return deterministicUuid(
    `chat-run:${userId}:${stateKey}:${messageId}:${clientRunSeed ?? "server"}`
  );
}

/**
 * Local error handler for chat route.
 * Maps domain errors to HTTP responses; returns null for unhandled errors.
 */
function handleRouteError(
  ctx: RequestContext,
  error: unknown,
  model?: string
): NextResponse | null {
  // Zod validation errors
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return NextResponse.json(
      { error: "Invalid input format" },
      { status: 400 }
    );
  }

  // Thread conflict (optimistic concurrency)
  if (error instanceof ThreadConflictError) {
    logRequestWarn(ctx.log, error, "THREAD_CONFLICT");
    return NextResponse.json(
      { error: "Thread conflict — please retry" },
      { status: 409 }
    );
  }

  if (error instanceof ChatTurnMismatchError) {
    logRequestWarn(ctx.log, error, "CHAT_TURN_MISMATCH");
    return NextResponse.json(
      { error: "Message identity already exists with different content" },
      { status: 409 }
    );
  }

  // Port-level credit errors (thrown directly by PreflightCreditCheckDecorator
  // during stream iteration — not mapped to feature errors by the facade in
  // the streaming path)
  if (isInsufficientCreditsPortError(error)) {
    logRequestWarn(ctx.log, error, "INSUFFICIENT_CREDITS");
    return NextResponse.json(
      { error: "Insufficient credits" },
      { status: 402 }
    );
  }

  // Execution errors from Temporal+Redis boundary (serialization-safe error codes)
  if (isAiExecutionError(error)) {
    const status = executionErrorToHttpStatus(error.code);
    logRequestWarn(ctx.log, error, error.code.toUpperCase());
    return NextResponse.json({ error: error.code }, { status });
  }

  // Chat validation errors (structured via ChatValidationError)
  if (error instanceof ChatValidationError) {
    logRequestWarn(ctx.log, error, "MESSAGE_VALIDATION_ERROR");
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Abort errors
  if (error instanceof Error && error.name === "AbortError") {
    logRequestWarn(ctx.log, error, "REQUEST_TIMEOUT");
    return NextResponse.json({ error: "Request timeout" }, { status: 408 });
  }

  // LLM errors (structured via LlmError kind/status)
  // Must precede isAccountsFeatureError — both use duck-typed .kind field
  if (isLlmError(error)) {
    if (error.kind === "timeout") {
      logRequestWarn(ctx.log, error, "REQUEST_TIMEOUT");
      return NextResponse.json({ error: "Request timeout" }, { status: 408 });
    }
    if (error.kind === "rate_limited" || error.status === 429) {
      logRequestWarn(ctx.log, error, "RATE_LIMIT_EXCEEDED");
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429 }
      );
    }
    if (error.status === 404) {
      logRequestWarn(ctx.log, error, "MODEL_UNAVAILABLE");
      return NextResponse.json(
        { code: "MODEL_UNAVAILABLE", model },
        { status: 409 }
      );
    }
    // Catch-all for other LLM errors (provider_4xx, provider_5xx, unknown)
    logRequestWarn(ctx.log, error, "LLM_SERVICE_UNAVAILABLE");
    return NextResponse.json(
      { error: "AI service temporarily unavailable" },
      { status: 503 }
    );
  }

  // Accounts feature errors
  if (isAccountsFeatureError(error)) {
    if (error.kind === "INSUFFICIENT_CREDITS") {
      logRequestWarn(ctx.log, error, "INSUFFICIENT_CREDITS");
      return NextResponse.json(
        { error: "Insufficient credits" },
        { status: 402 }
      );
    }
    if (error.kind === "BILLING_ACCOUNT_NOT_FOUND") {
      logRequestWarn(ctx.log, error, "BILLING_ACCOUNT_NOT_FOUND");
      return NextResponse.json({ error: "Account not found" }, { status: 403 });
    }
    if (error.kind === "VIRTUAL_KEY_NOT_FOUND") {
      logRequestWarn(ctx.log, error, "VIRTUAL_KEY_NOT_FOUND");
      return NextResponse.json(
        { error: "Virtual key not found" },
        { status: 403 }
      );
    }
    // Fallback for GENERIC
    logRequestWarn(ctx.log, error, "ACCOUNT_ERROR");
    return NextResponse.json(
      { error: error.kind === "GENERIC" ? error.message : "Account error" },
      { status: 400 }
    );
  }

  return null; // Unhandled → let wrapper catch as 500
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "ai.chat", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    let input: ChatInput | undefined;
    try {
      // Parse JSON body
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body" },
          { status: 400 }
        );
      }

      // Validate input with contract (safeParse for better error handling)
      const inputParseResult = aiChatOperation.input.safeParse(body);
      if (!inputParseResult.success) {
        logRequestWarn(ctx.log, inputParseResult.error, "VALIDATION_ERROR");
        return NextResponse.json(
          {
            error: "Invalid input",
            details: inputParseResult.error.flatten(),
          },
          { status: 400 }
        );
      }
      input = inputParseResult.data;

      // --- CLIENT_SENDS_USER_ONLY: message comes directly from input ---
      const userText = input.message;

      const handlerStartMs = performance.now();

      // modelRef validation is structural (Zod schema on contract).
      // Catalog-based allowlist check is deferred to execution-time preflight.

      if (!sessionUser) throw new Error("sessionUser required");

      // --- stateKey lifecycle ---
      const stateKey = input.stateKey ?? nanoid(21);
      const userId = toUserId(sessionUser.id);
      const threadPersistence = getContainer().threadPersistenceForUser(userId);

      // --- Load authoritative thread from DB ---
      const threadLoadStartMs = performance.now();
      let existingThread = await threadPersistence.loadThread(
        sessionUser.id,
        stateKey
      );
      aiChatPhaseDurationMs.observe(
        { phase: "thread_load" },
        performance.now() - threadLoadStartMs
      );
      let expectedLen = existingThread.length;

      const legacyIdempotencyKey = request.headers.get("idempotency-key");
      const legacySeed = legacyIdempotencyKey
        ? `${sessionUser.id}:${stateKey}:${legacyIdempotencyKey}`
        : undefined;
      const messageId =
        input.messageId ??
        (input.runId
          ? input.runId
          : legacySeed
            ? `idem-${createHash("sha256").update(legacySeed).digest("hex").slice(0, 32)}`
            : nanoid());
      const existingTurn = existingThread.find(
        (message) => message.id === messageId
      );
      let chatTurn: ChatTurnEnvelope = existingTurn
        ? assertSameTurn(existingTurn, input, sessionUser.id, stateKey)
        : {
            version: 1,
            messageDigest: messageDigest(input.message),
            serverRunId: deriveServerRunId(
              sessionUser.id,
              stateKey,
              messageId,
              input.runId
            ),
            ...(input.runId ? { clientRunSeed: input.runId } : {}),
            graphName: input.graphName,
            modelRef: input.modelRef,
          };
      let runId = chatTurn.serverRunId;

      // Build user UIMessage with immutable retry envelope.
      const userUIMessage: UIMessage = {
        id: messageId,
        role: "user",
        parts: [{ type: "text" as const, text: userText }],
        metadata: { chatTurn },
      };

      // --- Phase 1: persist user message before execution (optimistic) ---
      // Metadata (model, graphName) saved on INSERT only — first persist creates the thread row.
      const threadMetadata =
        expectedLen === 0
          ? { model: input.modelRef.modelId, graphName: input.graphName }
          : undefined;

      const userPersistStartMs = performance.now();
      let duplicateTurn = existingTurn !== undefined;
      let threadWithUser = duplicateTurn
        ? existingThread
        : [...existingThread, userUIMessage];
      if (!duplicateTurn) {
        try {
          await threadPersistence.saveThread(
            sessionUser.id,
            stateKey,
            redactSecretsInMessages(threadWithUser),
            expectedLen,
            threadMetadata
          );
        } catch (e) {
          if (!(e instanceof ThreadConflictError)) throw e;
          // Retry once: reload and suppress an exact concurrent duplicate.
          existingThread = await threadPersistence.loadThread(
            sessionUser.id,
            stateKey
          );
          expectedLen = existingThread.length;
          const concurrentTurn = existingThread.find(
            (message) => message.id === messageId
          );
          if (concurrentTurn) {
            chatTurn = assertSameTurn(
              concurrentTurn,
              input,
              sessionUser.id,
              stateKey
            );
            runId = chatTurn.serverRunId;
            duplicateTurn = true;
            threadWithUser = existingThread;
          } else {
            threadWithUser = [...existingThread, userUIMessage];
            await threadPersistence.saveThread(
              sessionUser.id,
              stateKey,
              redactSecretsInMessages(threadWithUser),
              expectedLen,
              expectedLen === 0 ? threadMetadata : undefined
            );
          }
        }
      }
      aiChatPhaseDurationMs.observe(
        { phase: "user_persist" },
        performance.now() - userPersistStartMs
      );
      if (duplicateTurn) aiChatDuplicateTurnsTotal.inc();
      const expectedLenAfterUser = threadWithUser.length;
      ctx.log.info(
        {
          reqId: ctx.reqId,
          userId: sessionUser.id,
          requestedModel: input.modelRef.modelId,
          providerKey: input.modelRef.providerKey,
          connectionId: input.modelRef.connectionId ?? null,
          threadMessages: expectedLenAfterUser,
          stateKey,
          messageId,
          runId,
          duplicateTurn,
        },
        "ai.chat_user_persisted"
      );

      // --- Convert persisted thread → DTOs for execution ---
      const messageDtos = uiMessagesToMessageDtos(threadWithUser);

      const idempotencyKey = input.messageId || input.runId
        ? `chat:${stateKey}:${messageId}`
        : (legacyIdempotencyKey ?? `chat:${stateKey}:${messageId}`);

      const {
        stream: deltaStream,
        final,
        runId: acceptedRunId,
        workflowId,
      } = await completionStream(
        {
          messages: messageDtos,
          modelRef: input.modelRef,
          sessionUser,
          abortSignal: request.signal,
          graphName: input.graphName,
          stateKey,
          idempotencyKey,
          serverRunId: runId,
          messageId,
          acceptanceMode: "workflow-start",
        },
        ctx
      );
      const streamStartMs = performance.now();

      ctx.log.info(
        {
          reqId: ctx.reqId,
          handlerMs: performance.now() - handlerStartMs,
          resolvedModel: input.modelRef.modelId,
          stateKey,
          messageId,
          runId: acceptedRunId,
          workflowId,
          stream: true,
        },
        "ai.chat_accepted"
      );

      // --- SSE reconciliation state (display only, NOT for persistence) ---
      // Per PERSIST_AFTER_PUMP: assistant persistence moved to execution layer (internal API route).
      // These variables track text_delta accumulation solely for SSE reconciliation:
      // if assistant_final has more content than deltas delivered, append the remainder to the SSE stream.
      let accumulatedText = "";
      let assistantFinalContent: string | undefined;
      let firstDeltaLogged = false;

      // --- Stream response via AI SDK Data Stream Protocol (SSE) ---
      const textPartId = `run-${acceptedRunId}`;
      let textBlockOpen = false;

      const uiStream = createUIMessageStream({
        execute: async ({ writer }) => {
          try {
            let eventSeq = 0;

            for await (const event of deltaStream) {
              if (request.signal.aborted) break;
              eventSeq++;

              if (event.type === "text_delta") {
                if (!firstDeltaLogged) {
                  firstDeltaLogged = true;
                  aiChatPhaseDurationMs.observe(
                    { phase: "first_text_delta" },
                    performance.now() - streamStartMs
                  );
                  ctx.log.info(
                    {
                      reqId: ctx.reqId,
                      stateKey,
                      messageId,
                      runId: acceptedRunId,
                      workflowId,
                    },
                    "ai.chat_first_delta"
                  );
                }
                accumulatedText += event.delta;
                if (!textBlockOpen) {
                  writer.write({ type: "text-start", id: textPartId });
                  textBlockOpen = true;
                }
                writer.write({
                  type: "text-delta",
                  delta: event.delta,
                  id: textPartId,
                });
              } else if (event.type === "assistant_final") {
                assistantFinalContent = event.content;
                ctx.log.debug(
                  {
                    seq: eventSeq,
                    accLen: accumulatedText.length,
                    finalLen: event.content.length,
                  },
                  "ai.chat_assistant_final_received"
                );
              } else if (event.type === "tool_call_start") {
                // Close text block before tool call
                if (textBlockOpen) {
                  writer.write({ type: "text-end", id: textPartId });
                  textBlockOpen = false;
                }

                ctx.log.info(
                  { toolCallId: event.toolCallId, toolName: event.toolName },
                  "tool_call_start received"
                );

                writer.write({
                  type: "tool-input-start",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                } as UIMessageChunk);

                if (event.args != null) {
                  writer.write({
                    type: "tool-input-available",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    input: event.args,
                  } as UIMessageChunk);
                }
              } else if (event.type === "tool_call_result") {
                writer.write({
                  type: "tool-output-available",
                  toolCallId: event.toolCallId,
                  output: event.result,
                } as UIMessageChunk);

                ctx.log.info(
                  { toolCallId: event.toolCallId },
                  "tool_call_result completed"
                );
              } else if (event.type === "status") {
                // STATUS_IS_EPHEMERAL: transient data part, never persisted in UIMessage
                // STATUS_BEST_EFFORT: safe to skip if stream is backpressured
                writer.write({
                  type: "data-status",
                  data: {
                    phase: event.phase,
                    ...(event.label ? { label: event.label } : {}),
                  },
                  transient: true,
                } as UIMessageChunk);
              }
            }

            // Reconcile: if assistant_final has text beyond what deltas delivered,
            // append the remainder.
            if (
              assistantFinalContent !== undefined &&
              assistantFinalContent.length > accumulatedText.length &&
              assistantFinalContent.startsWith(accumulatedText)
            ) {
              const remainder = assistantFinalContent.slice(
                accumulatedText.length
              );
              ctx.log.info(
                {
                  accLen: accumulatedText.length,
                  finalLen: assistantFinalContent.length,
                  remainderLen: remainder.length,
                },
                "ai.chat_reconcile_appending_remainder"
              );
              if (!textBlockOpen) {
                writer.write({ type: "text-start", id: textPartId });
                textBlockOpen = true;
              }
              writer.write({
                type: "text-delta",
                delta: remainder,
                id: textPartId,
              });
            } else if (
              assistantFinalContent !== undefined &&
              assistantFinalContent !== accumulatedText &&
              !assistantFinalContent.startsWith(accumulatedText)
            ) {
              ctx.log.warn(
                {
                  accLen: accumulatedText.length,
                  finalLen: assistantFinalContent.length,
                  accTail: accumulatedText.slice(-40),
                  finalTail: assistantFinalContent.slice(-40),
                },
                "ai.chat_reconcile_content_diverged"
              );
            }

            if (
              assistantFinalContent === undefined &&
              accumulatedText.length > 0
            ) {
              ctx.log.error(
                {
                  accLen: accumulatedText.length,
                  eventCount: eventSeq,
                },
                "ai.chat_assistant_final_missing — ASSISTANT_FINAL_REQUIRED violated"
              );
            }

            // Close text block if still open
            if (textBlockOpen) {
              writer.write({ type: "text-end", id: textPartId });
              textBlockOpen = false;
            }

            // Flush barrier
            await new Promise((r) => setTimeout(r, 0));

            // Wait for final result (billing) with 15s timeout
            const FINAL_TIMEOUT_MS = 15000;
            const finalTimeout = new Promise<{ ok: false; error: "timeout" }>(
              (resolve) =>
                setTimeout(
                  () => resolve({ ok: false, error: "timeout" }),
                  FINAL_TIMEOUT_MS
                )
            );

            const result = await Promise.race([final, finalTimeout]);

            if (result.ok) {
              // AI SDK uiMessageChunkSchema uses z.strictObject for finish —
              // only finishReason and messageMetadata are allowed (no usage).
              writer.write({
                type: "finish",
                finishReason: result.finishReason as
                  | "stop"
                  | "length"
                  | "tool-calls"
                  | "content-filter"
                  | "other"
                  | "error",
              });
            } else {
              ctx.log.warn(
                { reqId: ctx.reqId, error: result.error },
                "ai.chat_stream_final_error"
              );
              writer.write({
                type: "error",
                errorText: `Stream finalization failed: ${result.error}`,
              });
            }
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              ctx.log.info({ reqId: ctx.reqId }, "ai.chat_client_aborted");
            } else {
              ctx.log.error({ err: error }, "Stream error in route");
              throw error;
            }
          } finally {
            const streamMs = performance.now() - streamStartMs;
            aiChatStreamDurationMs.observe(streamMs);
            ctx.log.info(
              { reqId: ctx.reqId, streamMs },
              "ai.chat_stream_closed"
            );
          }
        },
      });

      // --- Phase 2 (assistant persistence) moved to execution layer ---
      // Per PERSIST_AFTER_PUMP: the internal API route persists the assistant message
      // after draining the full executor stream. This route is a pure SSE pipe.

      // Return SSE response with stateKey header for thread continuity
      // Wrap in NextResponse: createUIMessageStreamResponse returns Response,
      // but wrapRouteHandlerWithLogging expects NextResponse.
      const sseResponse = createUIMessageStreamResponse({
        stream: uiStream,
        headers: {
          "X-State-Key": stateKey,
          "X-Run-Id": acceptedRunId,
        },
      });
      return new NextResponse(sseResponse.body, {
        status: sseResponse.status,
        headers: sseResponse.headers,
      });
    } catch (error) {
      const errorResponse = handleRouteError(
        ctx,
        error,
        input?.modelRef?.modelId
      );
      if (errorResponse) return errorResponse;
      throw error; // Unhandled → wrapper catches
    }
  }
);
