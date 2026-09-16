// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/providers/ChatRuntimeProvider`
 * Purpose: Optimistic, draft-safe AI SDK chat runtime with durable stream resume.
 * Scope: Client transport, sessionStorage lifecycle, and run status UI only.
 * Invariants: Pre-ack POST retries preserve stateKey/messageId/clientRunSeed/body;
 *   replay uses only the tenant-scoped run ID acknowledged by the server.
 * Side-effects: Chat/threads fetches, sessionStorage, React Query invalidation.
 * Links: ai.chat.v1, GET /api/v1/ai/runs/{runId}/ui-stream
 * @public
 */

"use client";

import { useChat } from "@ai-sdk/react";
import {
  type AppendMessage,
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import type { GraphId, ModelRef } from "@cogni/ai-core";
import type { ChatError, LoadThreadOutput } from "@cogni/node-contracts";
import { clientLogger, EVENT_NAMES } from "@cogni/node-shared";
import { useQueryClient } from "@tanstack/react-query";
import type { CreateUIMessage, UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { createWebSpeechDictationAdapter } from "../adapters/web-speech-dictation.adapter";
import {
  type ChatRunPhase,
  acceptPendingEnvelope,
  clearChatDraft,
  clearPendingEnvelope,
  createPendingEnvelope,
  createReconnectRequest,
  type PendingChatEnvelope,
  readChatDraft,
  readPendingEnvelope,
  writeChatDraft,
  writePendingEnvelope,
} from "../hooks/chat-session.client";
import { mapHttpError } from "../utils/mapHttpError";

interface ChatRuntimeProviderProps {
  children: ReactNode;
  modelRef: ModelRef;
  selectedGraph: GraphId;
  defaultModelId: string;
  initialMessages: UIMessage[];
  /** Stable client-allocated key. The server must echo it in X-State-Key. */
  stateKey: string;
  onAuthExpired?: () => void;
  onError?: (error: ChatError) => void;
  onFinish?: () => void;
  onOptimisticSend?: (envelope: PendingChatEnvelope) => void;
}

export function ChatRuntimeProvider({
  children,
  modelRef,
  selectedGraph,
  defaultModelId,
  initialMessages,
  stateKey,
  onAuthExpired,
  onError,
  onFinish,
  onOptimisticSend,
}: ChatRuntimeProviderProps) {
  const queryClient = useQueryClient();
  const modelRefRef = useRef(modelRef);
  const selectedGraphRef = useRef(selectedGraph);
  const chatRef = useRef<ReturnType<typeof useChat<UIMessage>> | null>(null);
  // Storage is hydrated after mount so server/client markup is identical.
  const [pending, setPending] = useState<PendingChatEnvelope | null>(null);
  const pendingRef = useRef<PendingChatEnvelope | null>(null);
  const [phase, setPhase] = useState<ChatRunPhase>("idle");
  const resumedRunRef = useRef<string | null>(null);
  const hydratedStorageRef = useRef(false);

  useEffect(() => {
    modelRefRef.current = modelRef;
  }, [modelRef]);

  useEffect(() => {
    selectedGraphRef.current = selectedGraph;
  }, [selectedGraph]);

  useEffect(() => {
    if (hydratedStorageRef.current) return;
    hydratedStorageRef.current = true;
    const restored = readPendingEnvelope(stateKey);
    pendingRef.current = restored;
    setPending(restored);
    setPhase(restored?.accepted ? "reconnecting" : restored ? "failed" : "idle");
    if (
      restored &&
      !restored.accepted &&
      restored.message &&
      !initialMessages.some((message) => message.id === restored.messageId)
    ) {
      chatRef.current?.setMessages([
        ...initialMessages,
        {
          id: restored.messageId,
          role: "user",
          parts: [{ type: "text", text: restored.message }],
        },
      ]);
    }
  }, [initialMessages, stateKey]);

  const updatePending = useCallback((next: PendingChatEnvelope | null) => {
    pendingRef.current = next;
    setPending(next);
    if (next) writePendingEnvelope(next);
    else clearPendingEnvelope(stateKey);
  }, [stateKey]);

  const finishRun = useCallback(() => {
    updatePending(null);
    clearChatDraft(stateKey);
    setPhase("idle");
    queryClient.invalidateQueries({ queryKey: ["payments-summary"] });
    queryClient.invalidateQueries({ queryKey: ["ai-threads"] });
    onFinish?.();
  }, [onFinish, queryClient, stateKey, updatePending]);

  const reloadAuthoritativeThread = useCallback(async () => {
    const response = await globalThis.fetch(
      `/api/v1/ai/threads/${encodeURIComponent(stateKey)}`,
      { cache: "no-store" }
    );
    if (!response.ok) throw new Error("Unable to reload completed conversation");
    const thread = (await response.json()) as LoadThreadOutput;
    chatRef.current?.setMessages(thread.messages as UIMessage[]);
    finishRun();
  }, [finishRun, stateKey]);

  const handleResponse = useCallback(
    async (response: Response, method: string) => {
      if (method === "GET" && response.status === 410) {
        await reloadAuthoritativeThread();
        // AI SDK treats 204 as a clean replay miss and keeps the loaded history.
        return new Response(null, { status: 204 });
      }

      if (response.status === 401) {
        onAuthExpired?.();
        throw new Error("Unauthorized");
      }

      if (response.status === 402) {
        const body = await response.json().catch(() => ({}));
        onError?.(mapHttpError(402, body, crypto.randomUUID()));
        throw new Error("Insufficient credits");
      }

      if (response.status === 409) {
        const body = await response.json().catch(() => ({}));
        if (body.code === "MODEL_UNAVAILABLE") {
          clientLogger.warn(EVENT_NAMES.CLIENT_CHAT_MODEL_INVALID_RETRY, {
            model: modelRefRef.current.modelId,
            defaultModelId,
          });
          throw new Error("Invalid model");
        }
        onError?.(mapHttpError(409, body, crypto.randomUUID()));
        throw new Error(body.error || "Chat request identity conflict");
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        onError?.(
          mapHttpError(response.status, body, crypto.randomUUID())
        );
        throw new Error(body.error || "Request failed");
      }

      if (method === "POST") {
        const envelope = pendingRef.current;
        const responseStateKey = response.headers.get("X-State-Key");
        const responseRunId = response.headers.get("X-Run-Id");
        if (
          !envelope ||
          responseStateKey !== envelope.stateKey ||
          !responseRunId ||
          !isUuid(responseRunId)
        ) {
          throw new Error("Chat was not durably acknowledged");
        }
        updatePending(acceptPendingEnvelope(envelope, responseRunId));
        clearChatDraft(stateKey);
        setPhase("queued");
      }

      return response;
    },
    [defaultModelId, onAuthExpired, onError, reloadAuthoritativeThread, stateKey, updatePending]
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/v1/ai/chat",
        prepareSendMessagesRequest: () => {
          const envelope = pendingRef.current;
          if (!envelope?.message) {
            throw new Error("Missing stable chat request envelope");
          }
          return {
            body: {
              message: envelope.message,
              messageId: envelope.messageId,
              runId: envelope.clientRunSeed,
              modelRef: envelope.modelRef,
              graphName: envelope.graphName,
              stateKey: envelope.stateKey,
            },
          };
        },
        prepareReconnectToStreamRequest: () => {
          const envelope = pendingRef.current;
          if (!envelope) throw new Error("Missing run to reconnect");
          return createReconnectRequest(envelope);
        },
        fetch: async (url, init) => {
          const method = init?.method ?? "GET";
          const response = await globalThis.fetch(url, init);
          return handleResponse(response, method);
        },
      }),
    [handleResponse]
  );

  const toCreateMessage = useCallback(
    <UI_MESSAGE extends UIMessage>(
      message: AppendMessage
    ): CreateUIMessage<UI_MESSAGE> => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (pendingRef.current) {
        throw new Error("Finish or retry the active message before sending another");
      }
      const envelope = createPendingEnvelope({
        stateKey,
        message: text,
        modelRef: modelRefRef.current,
        graphName: selectedGraphRef.current,
      });
      updatePending(envelope);
      setPhase("saving");
      onOptimisticSend?.(envelope);
      return {
        id: envelope.messageId,
        role: "user",
        parts: [{ type: "text", text }],
        metadata: message.metadata,
      } as CreateUIMessage<UI_MESSAGE>;
    },
    [onOptimisticSend, stateKey, updatePending]
  );

  const chat = useChat<UIMessage>({
    id: stateKey,
    messages: initialMessages,
    transport,
    onData: (part) => {
      const cursor = getRunCursor(part);
      if (cursor && pendingRef.current) {
        updatePending({ ...pendingRef.current, cursor });
      }
      setPhase("running");
    },
    onFinish: finishRun,
    onError: (error) => {
      setPhase("failed");
      clientLogger.error(EVENT_NAMES.CLIENT_CHAT_STREAM_ERROR, {
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  chatRef.current = chat;

  const retry = useCallback(() => {
    const envelope = pendingRef.current;
    if (!envelope) return;
    chat.clearError();
    if (envelope.accepted) {
      setPhase("reconnecting");
      void chat.resumeStream();
    } else {
      setPhase("saving");
      void chat.regenerate({ messageId: envelope.messageId });
    }
  }, [chat]);

  useEffect(() => {
    const restored = pendingRef.current;
    if (
      !restored?.accepted ||
      !restored.runId ||
      resumedRunRef.current === restored.runId
    ) {
      return;
    }
    resumedRunRef.current = restored.runId;
    setPhase("reconnecting");
    void chat.resumeStream();
  }, [chat, pending?.accepted, pending?.runId]);

  const dictationAdapter = useMemo(() => createWebSpeechDictationAdapter(), []);
  const runtime = useAISDKRuntime(chat, {
    adapters: dictationAdapter ? { dictation: dictationAdapter } : undefined,
    toCreateMessage,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="relative h-full min-h-0">
        {children}
        <ChatDraftLifecycle
          stateKey={stateKey}
          pending={pending}
          phase={phase}
        />
        <ChatRunStatus phase={phase} onRetry={retry} />
      </div>
    </AssistantRuntimeProvider>
  );
}

function ChatDraftLifecycle({
  stateKey,
  pending,
  phase,
}: {
  stateKey: string;
  pending: PendingChatEnvelope | null;
  phase: ChatRunPhase;
}) {
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
  const restoredRef = useRef(false);
  const acceptedRef = useRef(pending?.accepted === true);
  acceptedRef.current = pending?.accepted === true;

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const restored = pending?.message ?? readChatDraft(stateKey);
    if (restored) aui.composer().setText(restored);
  }, [aui, pending, stateKey]);

  useEffect(() => {
    if (phase === "saving" && pending?.message && !composerText) {
      aui.composer().setText(pending.message);
    }
    if (pending?.accepted && composerText) {
      aui.composer().setText("");
    }
  }, [aui, composerText, pending, phase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (!pending?.accepted) writeChatDraft(stateKey, composerText);
    }, 250);
    return () => {
      window.clearTimeout(timeout);
      if (!acceptedRef.current) writeChatDraft(stateKey, composerText);
    };
  }, [composerText, pending?.accepted, stateKey]);

  return null;
}

function ChatRunStatus({
  phase,
  onRetry,
}: {
  phase: ChatRunPhase;
  onRetry: () => void;
}) {
  const labels: Record<ChatRunPhase, string> = {
    idle: "",
    saving: "Saving message…",
    queued: "Queued…",
    running: "Running…",
    reconnecting: "Reconnecting…",
    failed: "Message failed.",
  };

  return (
    <div
      className={`pointer-events-none absolute right-4 bottom-24 z-10 flex min-h-8 items-center gap-2 rounded-full border bg-background/95 px-3 py-1 text-muted-foreground text-xs shadow-sm backdrop-blur transition-opacity duration-200 ${phase === "idle" ? "invisible opacity-0" : "opacity-100"}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <span>{labels[phase]}</span>
      {phase === "failed" && (
        <button
          type="button"
          onClick={onRetry}
          className="pointer-events-auto font-medium text-foreground underline underline-offset-2"
        >
          Retry
        </button>
      )}
    </div>
  );
}

function getRunCursor(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const value = part as { type?: unknown; data?: unknown };
  if (value.type !== "data-run-cursor") return null;
  if (typeof value.data === "string") return value.data;
  if (!value.data || typeof value.data !== "object") return null;
  const data = value.data as { cursor?: unknown; id?: unknown };
  if (typeof data.cursor === "string") return data.cursor;
  return typeof data.id === "string" ? data.id : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}
