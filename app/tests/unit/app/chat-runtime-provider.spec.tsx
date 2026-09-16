// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/chat-runtime-provider`
 * Purpose: Verifies durable ACK, terminal cleanup, and replay lifecycle at the provider boundary.
 * Scope: Component test with AI SDK/runtime mocks; real sessionStorage helpers.
 * Invariants: Fresh ACK never double-attaches; abort is retryable; remount replay starts at origin.
 * @vitest-environment jsdom
 * @internal
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acceptPendingEnvelope,
  createPendingEnvelope,
  readPendingEnvelope,
  writePendingEnvelope,
} from "@/features/ai/chat/hooks/chat-session.client";
import { ChatRuntimeProvider } from "@/features/ai/chat/providers/ChatRuntimeProvider.client";

const sdk = vi.hoisted(() => ({
  chatOptions: null as Record<string, (...args: never[]) => unknown> | null,
  runtimeOptions: null as Record<string, (...args: never[]) => unknown> | null,
  transportOptions: null as Record<string, (...args: never[]) => unknown> | null,
  resumeStream: vi.fn(async () => undefined),
  regenerate: vi.fn(async () => undefined),
  clearError: vi.fn(),
  setMessages: vi.fn(),
  setText: vi.fn(),
  stop: vi.fn(),
  messages: [] as UIMessage[],
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: Record<string, (...args: never[]) => unknown>) => {
    sdk.chatOptions = options;
    return {
      clearError: sdk.clearError,
      regenerate: sdk.regenerate,
      resumeStream: sdk.resumeStream,
      setMessages: sdk.setMessages,
      stop: sdk.stop,
      messages: sdk.messages,
    };
  },
}));

vi.mock("@assistant-ui/react-ai-sdk", () => ({
  useAISDKRuntime: (
    _chat: unknown,
    options: Record<string, (...args: never[]) => unknown>
  ) => {
    sdk.runtimeOptions = options;
    return {};
  },
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => children,
  useAui: () => ({ composer: () => ({ setText: sdk.setText }) }),
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({ composer: { text: "" } }),
}));

vi.mock("ai", () => ({
  DefaultChatTransport: class {
    constructor(options: Record<string, (...args: never[]) => unknown>) {
      sdk.transportOptions = options;
    }
  },
}));

vi.mock("@cogni/node-shared", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn() },
  EVENT_NAMES: {
    CLIENT_CHAT_STREAM_ERROR: "stream-error",
    CLIENT_CHAT_MODEL_INVALID_RETRY: "model-error",
  },
}));

const stateKey = "thread-provider-test";
const serverRunId = "22222222-2222-4222-8222-222222222222";

function pending() {
  let id = 0;
  return createPendingEnvelope({
    stateKey,
    message: "hello",
    modelRef: { providerKey: "platform", modelId: "test-model" },
    graphName: "langgraph:default",
    generateId: () => `client-${++id}`,
  });
}

function renderProvider(
  initialMessages: UIMessage[] = [],
  callbacks: { onFinish?: () => void; onSettled?: () => void } = {}
) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider
        modelRef={{ providerKey: "platform", modelId: "test-model" }}
        selectedGraph="langgraph:default"
        defaultModelId="test-model"
        initialMessages={initialMessages}
        stateKey={stateKey}
        onFinish={callbacks.onFinish}
        onSettled={callbacks.onSettled}
      >
        <div>chat</div>
      </ChatRuntimeProvider>
    </QueryClientProvider>
  );
}

describe("ChatRuntimeProvider durable lifecycle", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    sdk.chatOptions = null;
    sdk.runtimeOptions = null;
    sdk.transportOptions = null;
    sdk.messages = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not open a concurrent replay connection after a fresh POST ACK", async () => {
    const view = renderProvider();
    const toCreateMessage = sdk.runtimeOptions?.toCreateMessage;
    expect(toCreateMessage).toBeTypeOf("function");
    act(() => {
      toCreateMessage?.({
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: { custom: {} },
      } as never);
    });
    const prepared = sdk.transportOptions?.prepareSendMessagesRequest?.() as {
      body: { runId: string };
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "X-State-Key": stateKey, "X-Run-Id": serverRunId },
      })
    );
    await act(async () => {
      await sdk.transportOptions?.fetch?.("/api/v1/ai/chat", {
        method: "POST",
      } as never);
    });

    expect(sdk.resumeStream).not.toHaveBeenCalled();
    const stored = readPendingEnvelope(stateKey);
    expect(stored).toMatchObject({
      accepted: true,
      runId: serverRunId,
      clientRunSeed: prepared.body.runId,
    });
    expect(stored?.clientRunSeed).not.toBe(serverRunId);
    const attachedSignal = (fetchSpy.mock.calls[0]?.[1] as RequestInit).signal;
    view.unmount();
    expect(attachedSignal?.aborted).toBe(true);
    expect(sdk.stop).toHaveBeenCalledOnce();
    expect(readPendingEnvelope(stateKey)).not.toBeNull();
    fetchSpy.mockRestore();
  });

  it("retains accepted work on abort and clears it only on terminal success", async () => {
    writePendingEnvelope(acceptPendingEnvelope(pending(), serverRunId));
    renderProvider();
    await waitFor(() => expect(sdk.resumeStream).toHaveBeenCalledOnce());

    act(() => {
      sdk.chatOptions?.onFinish?.({
        isAbort: true,
        isDisconnect: false,
        isError: false,
        finishReason: "stop",
      } as never);
    });
    expect(readPendingEnvelope(stateKey)).not.toBeNull();

    act(() => {
      sdk.chatOptions?.onFinish?.({
        isAbort: false,
        isDisconnect: false,
        isError: false,
        finishReason: undefined,
      } as never);
    });
    expect(readPendingEnvelope(stateKey)).not.toBeNull();

    act(() => {
      sdk.chatOptions?.onFinish?.({
        isAbort: false,
        isDisconnect: false,
        isError: false,
        finishReason: "stop",
      } as never);
    });
    expect(readPendingEnvelope(stateKey)).toBeNull();
  });

  it("uses cursor in-memory, then restarts replay from origin after remount", async () => {
    writePendingEnvelope(acceptPendingEnvelope(pending(), serverRunId));
    const first = renderProvider();
    await waitFor(() => expect(sdk.resumeStream).toHaveBeenCalledOnce());
    act(() => {
      sdk.chatOptions?.onData?.({
        type: "data-run-cursor",
        data: { cursor: "9-1" },
      } as never);
    });
    expect(sdk.transportOptions?.prepareReconnectToStreamRequest?.()).toEqual({
      api: `/api/v1/ai/runs/${serverRunId}/ui-stream`,
      headers: { "Last-Event-ID": "9-1" },
    });

    first.unmount();
    expect(sdk.stop).toHaveBeenCalledOnce();
    expect(readPendingEnvelope(stateKey)).not.toBeNull();
    sdk.resumeStream.mockClear();
    renderProvider();
    await waitFor(() => expect(sdk.resumeStream).toHaveBeenCalledOnce());
    expect(sdk.transportOptions?.prepareReconnectToStreamRequest?.()).toEqual({
      api: `/api/v1/ai/runs/${serverRunId}/ui-stream`,
    });
  });

  it("uses authoritative terminal history without replay duplication", async () => {
    const onSettled = vi.fn();
    writePendingEnvelope(acceptPendingEnvelope(pending(), serverRunId));
    renderProvider(
      [
        {
          id: `assistant-${serverRunId}`,
          role: "assistant",
          parts: [{ type: "text", text: "complete" }],
        },
      ],
      { onSettled }
    );
    await waitFor(() => expect(readPendingEnvelope(stateKey)).toBeNull());
    expect(sdk.resumeStream).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("hydrates an unaccepted existing-thread turn on top of durable history", async () => {
    const restored = createPendingEnvelope({
      stateKey,
      message: "follow up",
      modelRef: { providerKey: "platform", modelId: "test-model" },
      graphName: "langgraph:default",
      hasDurableHistory: true,
      generateId: () => "pending-id",
    });
    writePendingEnvelope(restored);
    const history: UIMessage[] = [
      {
        id: "prior-user",
        role: "user",
        parts: [{ type: "text", text: "prior" }],
      },
    ];
    renderProvider(history);

    await waitFor(() =>
      expect(sdk.setMessages).toHaveBeenCalledWith([
        ...history,
        {
          id: restored.messageId,
          role: "user",
          parts: [{ type: "text", text: "follow up" }],
        },
      ])
    );
    expect(sdk.resumeStream).not.toHaveBeenCalled();
  });

  it("lets the user discard a rejected pre-ack envelope and edit its text", async () => {
    renderProvider();
    act(() => {
      sdk.runtimeOptions?.toCreateMessage?.({
        role: "user",
        content: [{ type: "text", text: "bad model request" }],
      } as never);
      sdk.chatOptions?.onError?.(new Error("Invalid model") as never);
    });

    expect(readPendingEnvelope(stateKey)).not.toBeNull();
    screen.getByRole("button", { name: "Edit message" }).click();

    expect(readPendingEnvelope(stateKey)).toBeNull();
    expect(sdk.setMessages).toHaveBeenCalledWith([]);
  });

  it("clears accepted work as successful only for a successful terminal replay", async () => {
    const onFinish = vi.fn();
    const onSettled = vi.fn();
    writePendingEnvelope(acceptPendingEnvelope(pending(), serverRunId));
    renderProvider([], { onFinish, onSettled });
    await waitFor(() => expect(sdk.resumeStream).toHaveBeenCalledOnce());
    const messages = [
      {
        id: `assistant-${serverRunId}`,
        role: "assistant",
        parts: [{ type: "text", text: "complete" }],
      },
    ];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { error: "Run is terminal", terminalStatus: "success" },
          { status: 410 }
        )
      )
      .mockResolvedValueOnce(Response.json({ messages }));

    let response: Response | undefined;
    await act(async () => {
      response = (await sdk.transportOptions?.fetch?.("/ui-stream", {
        method: "GET",
      } as never)) as Response;
    });

    expect(response?.status).toBe(204);
    expect(sdk.setMessages).toHaveBeenCalledWith(messages);
    expect(readPendingEnvelope(stateKey)).toBeNull();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it.each([
    ["error", "Run failed."],
    ["skipped", "Run was skipped."],
    ["cancelled", "Run was cancelled."],
  ] as const)(
    "surfaces terminal %s without mislabeling it as success",
    async (terminalStatus, label) => {
      const onFinish = vi.fn();
      const onSettled = vi.fn();
      writePendingEnvelope(acceptPendingEnvelope(pending(), serverRunId));
      renderProvider([], { onFinish, onSettled });
      await waitFor(() => expect(sdk.resumeStream).toHaveBeenCalledOnce());
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json(
            { error: "Run is terminal", terminalStatus, errorCode: "TEST" },
            { status: 410 }
          )
        )
        .mockResolvedValueOnce(Response.json({ messages: [] }));

      await act(async () => {
        await sdk.transportOptions?.fetch?.("/ui-stream", {
          method: "GET",
        } as never);
      });

      expect(sdk.setMessages).toHaveBeenCalledWith([]);
      expect(readPendingEnvelope(stateKey)).toBeNull();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(onFinish).not.toHaveBeenCalled();
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(() =>
        sdk.runtimeOptions?.toCreateMessage?.({
          role: "user",
          content: [{ type: "text", text: "next" }],
        } as never)
      ).not.toThrow();
    }
  );

  it("bounds replay visibility retries and keeps one logical envelope", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    writePendingEnvelope(acceptPendingEnvelope(pending(), serverRunId));
    renderProvider();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 425 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const replay = sdk.transportOptions?.fetch?.("/ui-stream", {
      method: "GET",
    } as never) as Promise<Response>;
    await vi.runAllTimersAsync();
    await expect(replay).resolves.toHaveProperty("status", 200);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(readPendingEnvelope(stateKey)).not.toBeNull();
    vi.useRealTimers();
  });
});
