// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/chat-view-navigation`
 * Purpose: Verifies optimistic URL/navigation behavior without remount races or phantom threads.
 * Scope: ChatView component with feature/network boundaries mocked.
 * Invariants: First submit replaces in-place; explicit selection pushes/remounts; load errors block runtime.
 * @vitest-environment jsdom
 * @internal
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatView } from "@/app/(app)/chat/view";
import { useChatSidebarStore } from "@/features/ai/chat/components/ChatSidebarContext";
import { readNewThreadStateKey } from "@/features/ai/chat/hooks/chat-session.client";
import { ThreadFetchError } from "@/features/ai/chat/hooks/useThreads";

const nav = vi.hoisted(() => ({
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
  mounts: 0,
  unmounts: 0,
  threadError: null as Error | null,
  loadedThreadKey: null as string | null,
  loadedMessages: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/features/payments/public", () => ({
  useCreditsSummary: () => ({
    data: { balanceCredits: 0, ledger: [] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/features/ai/public", () => ({
  ChatComposerExtras: () => null,
  ChatErrorBubble: () => null,
  DEFAULT_GRAPH_ID: "langgraph:default",
  getPreferredModelId: () => null,
  setPreferredModelId: vi.fn(),
  pickDefaultModel: () => "free-model",
  useModels: () => ({
    data: {
      models: [
        {
          ref: { providerKey: "platform", modelId: "free-model" },
          requiresPlatformCredits: false,
        },
      ],
      defaultRef: { providerKey: "platform", modelId: "free-model" },
    },
    isError: false,
    refetch: vi.fn(),
  }),
  useThreads: () => ({ data: { threads: [] } }),
  useLoadThread: (stateKey: string) => {
    nav.loadedThreadKey = stateKey;
    return {
      data:
        nav.loadedMessages.length > 0
          ? { stateKey, messages: nav.loadedMessages }
          : undefined,
      isPending: false,
      isError: nav.threadError != null,
      error: nav.threadError,
      refetch: vi.fn(),
    };
  },
  useDeleteThread: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/features/ai/components/ModelPicker", () => ({ CHATGPT_MODELS: [] }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

vi.mock("@/components", () => ({
  Thread: () => <div data-testid="thread" />,
  ErrorAlert: ({ code }: { code: string }) => (
    <div data-testid="thread-error">{code}</div>
  ),
}));

vi.mock("@/features/ai/chat/providers/ChatRuntimeProvider.client", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ChatRuntimeProvider: (props: {
      stateKey: string;
      children: React.ReactNode;
      onOptimisticSend: (envelope: Record<string, unknown>) => void;
      onSettled: () => void;
      initialMessages: unknown[];
    }) => {
      React.useEffect(() => {
        nav.mounts += 1;
        return () => {
          nav.unmounts += 1;
        };
      }, []);
      return (
        <div
          data-testid="provider"
          data-state-key={props.stateKey}
          data-initial-count={props.initialMessages.length}
        >
          <button
            type="button"
            onClick={() =>
              props.onOptimisticSend({
                stateKey: props.stateKey,
                messageId: "message-1",
                clientRunSeed: "11111111-1111-4111-8111-111111111111",
                message: "hello",
                modelRef: { providerKey: "platform", modelId: "free-model" },
                graphName: "langgraph:default",
                createdAt: "2026-09-15T00:00:00.000Z",
              })
            }
          >
            send
          </button>
          <button type="button" onClick={props.onSettled}>
            terminal error settled
          </button>
          {props.children}
        </div>
      );
    },
  };
});

function renderView() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatView />
    </QueryClientProvider>
  );
}

describe("ChatView navigation lifecycle", () => {
  beforeEach(() => {
    sessionStorage.clear();
    nav.search = "";
    nav.mounts = 0;
    nav.unmounts = 0;
    nav.threadError = null;
    nav.loadedThreadKey = null;
    nav.loadedMessages = [];
    vi.clearAllMocks();
  });

  it("replaces the first-submit URL without remount and pushes explicit selection", async () => {
    renderView();
    await screen.findByTestId("provider");
    const stateKey = screen.getByTestId("provider").dataset.stateKey as string;

    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(nav.replace).toHaveBeenCalledWith(
      `/chat?thread=${stateKey}`,
      { scroll: false }
    );
    expect(nav.mounts).toBe(1);
    expect(nav.unmounts).toBe(0);
    expect(readNewThreadStateKey()).toBe(stateKey);

    act(() => useChatSidebarStore.getState().onSelectThread?.("thread-2"));
    expect(nav.push).toHaveBeenCalledWith("/chat?thread=thread-2");
    await waitFor(() => expect(nav.mounts).toBe(2));
    expect(nav.unmounts).toBe(1);
  });

  it("clears the new-thread pointer on terminal failure and cold-loads authoritative history", async () => {
    const first = renderView();
    await screen.findByTestId("provider");
    const stateKey = screen.getByTestId("provider").dataset.stateKey as string;
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(readNewThreadStateKey()).toBe(stateKey);

    fireEvent.click(
      screen.getByRole("button", { name: "terminal error settled" })
    );
    expect(readNewThreadStateKey()).toBeNull();

    first.unmount();
    nav.search = `thread=${stateKey}`;
    nav.loadedMessages = [
      {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ];
    renderView();

    await waitFor(() => expect(nav.loadedThreadKey).toBe(stateKey));
    expect(await screen.findByTestId("provider")).toHaveAttribute(
      "data-initial-count",
      "1"
    );
  });

  it.each([
    [401, "THREAD_LOAD_FAILED"],
    [404, "THREAD_NOT_FOUND"],
    [500, "THREAD_LOAD_FAILED"],
  ])(
    "shows a %i load error instead of mounting an empty phantom thread",
    async (status, code) => {
    nav.search = "thread=missing";
      nav.threadError = new ThreadFetchError("load failed", status);
    renderView();

    expect(await screen.findByTestId("thread-error")).toHaveTextContent(
        code
    );
    expect(screen.queryByTestId("provider")).toBeNull();
    }
  );
});
