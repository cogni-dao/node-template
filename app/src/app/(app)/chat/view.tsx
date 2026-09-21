// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/chat/view`
 * Purpose: Chat view with assistant-ui Thread. Thread history lives in the global AppSidebar via Zustand store.
 * Scope: Client component that renders model/graph selection and ChatRuntimeProvider with key-based remount. Wrapped in Suspense by page.tsx for useSearchParams() support.
 * Invariants:
 *   - INV-UI-NO-PAID-DEFAULT-WHEN-ZERO: gates rendering until models + credits resolve
 *   - INV-NO-CLIENT-INVENTED-MODEL-IDS: all model IDs from server's models list
 *   - KEY_REMOUNT: `key={activeThreadKey ?? "new"}` forces full unmount/remount on thread switch, aborting in-flight streams
 *   - LOADING_GATE: `isThreadLoading` prevents ChatRuntimeProvider render until thread messages load
 * Side-effects: IO (chat API, thread list/load/delete via React Query)
 * Notes: Thread sidebar state is registered into useChatSidebarStore for the global AppSidebar to consume.
 * Links: src/features/ai/chat/providers/ChatRuntimeProvider.client.tsx, src/features/ai/chat/hooks/useThreads.ts
 * @public
 */

"use client";

import type { ModelRef } from "@cogni/ai-core";
import type {
  ChatError,
  ListThreadsOutput,
  ThreadSummary,
} from "@cogni/node-contracts";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { useRouter, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ErrorAlert, Thread } from "@/components";
import { useChatSidebarStore } from "@/features/ai/chat/components/ChatSidebarContext";
import {
  clearNewThreadStateKey,
  createChatIds,
  type PendingChatEnvelope,
  readNewThreadStateKey,
  readPendingEnvelope,
  shouldLoadExistingThread,
  writeNewThreadStateKey,
} from "@/features/ai/chat/hooks/chat-session.client";
import { ChatRuntimeProvider } from "@/features/ai/chat/providers/ChatRuntimeProvider.client";
import { ThreadFetchError } from "@/features/ai/chat/hooks/useThreads";
import { toErrorAlertProps } from "@/features/ai/chat/utils/toErrorAlertProps";
import { CHATGPT_MODELS } from "@/features/ai/components/ModelPicker";
import {
  ChatComposerExtras,
  ChatErrorBubble,
  DEFAULT_GRAPH_ID,
  getPreferredModelId,
  pickDefaultModel,
  setPreferredModelId,
  useDeleteThread,
  useLoadThread,
  useModels,
  useThreads,
} from "@/features/ai/public";
import { useCreditsSummary } from "@/features/payments/public";
import type { GraphId } from "@/ports";

const ChatWelcomeWithHint = () => (
  <div className="mx-auto flex h-full w-full max-w-[var(--thread-max-width)] flex-col items-center justify-center">
    <div className="flex flex-col justify-center gap-1 px-8">
      <div className="fade-in slide-in-from-bottom-2 animate-in text-lg text-muted-foreground/65 duration-300 ease-out sm:text-2xl">
        Clone this living mind
      </div>
      <div className="fade-in slide-in-from-bottom-2 animate-in text-lg text-muted-foreground/65 delay-100 duration-300 ease-out sm:text-2xl">
        Teach it what your people need
      </div>
      <div className="fade-in slide-in-from-bottom-2 animate-in text-lg text-muted-foreground/65 delay-200 duration-300 ease-out sm:text-2xl">
        Intelligence, shared.
      </div>
    </div>
  </div>
);

export function ChatView(): ReactNode {
  const router = useRouter();
  const modelsQuery = useModels();
  const creditsQuery = useCreditsSummary();
  const { data: creditsData, isLoading: isCreditsLoading } = creditsQuery;
  // Display raw balance (including negative); no unsafe defaults
  const balance = creditsData?.balanceCredits ?? 0;

  // Refs for user intent tracking (prevent re-init after user selection)
  const hasUserSelectedRef = useRef(false);
  const hasInitializedRef = useRef(false);

  // State
  const [selectedModelRef, setSelectedModelRef] = useState<ModelRef | null>(
    null
  );
  const [selectedGraph, setSelectedGraph] = useState(DEFAULT_GRAPH_ID);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  const [isBlocked, setIsBlocked] = useState(false);

  // Runtime identity is intentionally separate from the URL thread key. The first
  // submit replaces the URL with the already-mounted runtime's preallocated key.
  // Explicit navigation creates a new runtime and therefore aborts only the view,
  // never the durable server run.
  const searchParams = useSearchParams();
  const [threadSession, setThreadSession] = useState(() => {
    const urlStateKey = searchParams?.get("thread");
    return {
      stateKey:
        urlStateKey ?? readNewThreadStateKey() ?? createChatIds().stateKey,
      committed: urlStateKey != null,
      loadExisting: false,
      sessionHydrated: false,
      runtimeKey: crypto.randomUUID(),
    };
  });
  const navigationTargetRef = useRef<string | null>(null);
  // Extract server-provided defaults (NO CLIENT INVENTION)
  const models = modelsQuery.data?.models ?? [];
  const defaultPreferredModelId = modelsQuery.data?.defaultRef?.modelId ?? null;
  const defaultFreeModelId =
    models.find((m) => !m.requiresPlatformCredits)?.ref.modelId ?? null;
  const freeModelIds = models
    .filter((m) => !m.requiresPlatformCredits)
    .map((m) => m.ref.modelId);

  // Single initialization effect
  // biome-ignore lint/correctness/useExhaustiveDependencies: models derived from modelsQuery.data (already in deps)
  useEffect(() => {
    // Skip if user already selected or already initialized
    if (hasInitializedRef.current || hasUserSelectedRef.current) return;
    // Wait for both data sources
    if (isCreditsLoading || !modelsQuery.data) return;

    const userChoice = getPreferredModelId();

    // MF-6: Feature-layer validation - if zero credits, ensure userChoice is free
    let validatedChoice = userChoice;
    if (balance <= 0 && userChoice && !freeModelIds.includes(userChoice)) {
      validatedChoice = null; // Invalidate paid model selection when out of credits
    }

    const selected = pickDefaultModel({
      balanceCredits: balance,
      userChoice: validatedChoice,
      defaultFreeModelId,
      defaultPaidModelId: defaultPreferredModelId,
    });

    if (selected) {
      // Find the model ref from the models list.
      // ChatGPT models aren't in the server models list — they're hardcoded in
      // ModelPicker. If the stored preference is a ChatGPT model, build the ref
      // with providerKey "codex". connectionId will be set when ModelPicker's
      // status fetch completes and the user re-selects or the tab initializes.
      const matchedModel = models.find((m) => m.ref.modelId === selected);
      const isChatGptModel = CHATGPT_MODELS.some((m) => m.id === selected);
      setSelectedModelRef(
        matchedModel?.ref ??
          (isChatGptModel
            ? { providerKey: "codex", modelId: selected }
            : { providerKey: "platform", modelId: selected })
      );
      setIsBlocked(false);
    } else {
      // No valid model: blocked state (zero credits + no free models)
      setIsBlocked(true);
      setChatError({
        code: "NO_FREE_MODELS",
        message: "No free models available. Add credits to continue chatting.",
        retryable: false,
        blocking: true,
        suggestedAction: "add_credits",
      });
    }

    hasInitializedRef.current = true;
  }, [
    isCreditsLoading,
    balance,
    modelsQuery.data,
    freeModelIds,
    defaultFreeModelId,
    defaultPreferredModelId,
  ]);
  // NOTE: selectedModelRef intentionally NOT in deps to prevent re-init loop

  // Model change handler - marks user intent
  const handleModelChange = useCallback((ref: ModelRef) => {
    hasUserSelectedRef.current = true;
    setSelectedModelRef(ref);
    setPreferredModelId(ref.modelId);
    setIsBlocked(false);
    setChatError(null);
  }, []);

  // Graph change handler
  const handleGraphChange = useCallback((graphId: GraphId) => {
    setSelectedGraph(graphId);
  }, []);

  // Error handler from provider
  const handleError = useCallback((error: ChatError) => {
    setChatError(error);
  }, []);

  // Switch to free model action
  const handleSwitchFreeModel = useCallback(() => {
    if (defaultFreeModelId) {
      const freeModel = models.find(
        (m) => m.ref.modelId === defaultFreeModelId
      );
      handleModelChange(
        freeModel?.ref ?? {
          providerKey: "platform",
          modelId: defaultFreeModelId,
        }
      );
    }
  }, [defaultFreeModelId, models, handleModelChange]);

  // Retry action - clear error (runtime handles retry internally)
  const handleRetry = useCallback(() => {
    setChatError(null);
  }, []);

  const handleBootRetry = useCallback(() => {
    void Promise.all([modelsQuery.refetch(), creditsQuery.refetch()]);
  }, [creditsQuery, modelsQuery]);

  // Add credits action (navigate to credits page)
  const handleAddCredits = useCallback(() => {
    window.location.href = "/credits";
  }, []);

  // Thread data hooks
  const queryClient = useQueryClient();
  const threadsQuery = useThreads();
  const threadData = useLoadThread(
    threadSession.sessionHydrated && threadSession.loadExisting
      ? threadSession.stateKey
      : null
  );
  const deleteThread = useDeleteThread();

  const openThread = useCallback(
    (stateKey: string, loadExisting: boolean, committed = loadExisting) => {
      setChatError(null);
      setThreadSession({
        stateKey,
        committed,
        loadExisting,
        sessionHydrated: true,
        runtimeKey: crypto.randomUUID(),
      });
    },
    []
  );

  const handleSelectThread = useCallback(
    (key: string) => {
      navigationTargetRef.current = key;
      openThread(key, true);
      router.push(`/chat?thread=${encodeURIComponent(key)}`);
    },
    [openThread, router]
  );

  const handleNewThread = useCallback(() => {
    navigationTargetRef.current = "";
    const stateKey = createChatIds().stateKey;
    writeNewThreadStateKey(stateKey);
    openThread(stateKey, false);
    router.push("/chat");
  }, [openThread, router]);

  const handleDeleteThread = useCallback(
    (key: string) => {
      deleteThread.mutate(key);
      if (threadSession.stateKey === key) handleNewThread();
    },
    [deleteThread, handleNewThread, threadSession.stateKey]
  );

  const handleThreadSettled = useCallback(() => {
    clearNewThreadStateKey(threadSession.stateKey);
    queryClient.invalidateQueries({ queryKey: ["ai-threads"] });
  }, [queryClient, threadSession.stateKey]);

  const handleOptimisticSend = useCallback(
    (envelope: PendingChatEnvelope) => {
      const optimisticThread: ThreadSummary = {
        stateKey: envelope.stateKey,
        title: (envelope.message ?? "Untitled").slice(0, 100),
        updatedAt: envelope.createdAt,
        messageCount: 1,
        metadata: {
          modelRef: envelope.modelRef,
          graphName: envelope.graphName,
          pending: true,
        },
      };

      navigationTargetRef.current = envelope.stateKey;
      queryClient.setQueriesData<ListThreadsOutput>(
        { queryKey: ["ai-threads"] },
        (current) => ({
          threads: [
            optimisticThread,
            ...(current?.threads ?? []).filter(
              (thread) => thread.stateKey !== envelope.stateKey
            ),
          ],
        })
      );

      // Mark active for the sidebar without changing runtimeKey or loading history.
      setThreadSession((current) =>
        current.stateKey === envelope.stateKey
          ? { ...current, committed: true }
          : current
      );
      router.replace(
        `/chat?thread=${encodeURIComponent(envelope.stateKey)}`,
        { scroll: false }
      );
    },
    [queryClient, router]
  );

  // Reconcile browser Back/Forward (and external URL changes) with one runtime.
  useEffect(() => {
    const urlStateKey = searchParams?.get("thread");
    if (!threadSession.sessionHydrated) {
      if (!urlStateKey) writeNewThreadStateKey(threadSession.stateKey);
      setThreadSession((current) => ({
        ...current,
        loadExisting:
          urlStateKey != null &&
          shouldLoadExistingThread(readPendingEnvelope(current.stateKey)),
        sessionHydrated: true,
      }));
      return;
    }
    if (navigationTargetRef.current != null) {
      if (navigationTargetRef.current === (urlStateKey ?? "")) {
        navigationTargetRef.current = null;
      } else {
        return;
      }
    }
    if (urlStateKey === threadSession.stateKey) return;
    if (urlStateKey) {
      openThread(
        urlStateKey,
        shouldLoadExistingThread(readPendingEnvelope(urlStateKey)),
        true
      );
      return;
    }
    if (threadSession.committed) {
      const stateKey =
        readNewThreadStateKey() ?? createChatIds().stateKey;
      writeNewThreadStateKey(stateKey);
      openThread(stateKey, false);
    }
  }, [openThread, searchParams, threadSession]);

  // Register thread state with global sidebar store
  const registerSidebar = useChatSidebarStore((s) => s.register);
  const unregisterSidebar = useChatSidebarStore((s) => s.unregister);

  useEffect(() => {
    registerSidebar({
      threads: threadsQuery.data?.threads ?? [],
      activeThreadKey: threadSession.committed
        ? threadSession.stateKey
        : null,
      onSelectThread: handleSelectThread,
      onNewThread: handleNewThread,
      onDeleteThread: handleDeleteThread,
    });
  }, [
    registerSidebar,
    threadsQuery.data?.threads,
    threadSession,
    handleSelectThread,
    handleNewThread,
    handleDeleteThread,
  ]);

  useEffect(() => {
    return () => unregisterSidebar();
  }, [unregisterSidebar]);

  // Prepare error alert props
  const errorAlertProps = chatError
    ? toErrorAlertProps(chatError, !!defaultFreeModelId)
    : null;

  if (modelsQuery.isError || creditsQuery.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
        <div className="mx-auto w-full max-w-[var(--size-container-sm)] px-4">
          <ErrorAlert
            code="CHAT_BOOT_FAILED"
            message="Chat could not load models or account status. Check your connection and try again."
            retryable={true}
            showRetry={true}
            showSwitchFree={false}
            showAddCredits={false}
            onRetry={handleBootRetry}
          />
        </div>
      </div>
    );
  }

  // INV-UI-NO-PAID-DEFAULT-WHEN-ZERO: Gate rendering until init completes
  if (!hasInitializedRef.current) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // INV-NO-INTERACTION-BEFORE-READY: Blocked state shows error only, no chat
  if (isBlocked && !selectedModelRef) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
        <div className="mx-auto w-full max-w-[var(--size-container-sm)] px-4">
          {errorAlertProps && (
            <ErrorAlert
              code={errorAlertProps.code}
              message={errorAlertProps.message}
              retryable={errorAlertProps.retryable}
              showRetry={errorAlertProps.showRetry}
              showSwitchFree={errorAlertProps.showSwitchFree}
              showAddCredits={errorAlertProps.showAddCredits}
              onRetry={handleRetry}
              onSwitchFreeModel={handleSwitchFreeModel}
              onAddCredits={handleAddCredits}
            />
          )}
        </div>
      </div>
    );
  }

  // Compute UI default model based on credits (NO HARDCODED FALLBACKS)
  // INV-NO-CLIENT-INVENTED-MODEL-IDS: UI must NEVER invent model IDs
  const uiDefaultModelId =
    balance <= 0 ? defaultFreeModelId : defaultPreferredModelId;

  // Invariant: selectedModelRef is guaranteed non-null after initialization gate
  if (!selectedModelRef) {
    throw new Error(
      "INV-VIOLATION: selectedModelRef is null after initialization gate"
    );
  }

  // Invariant: uiDefaultModelId must exist (server provides valid default)
  if (!uiDefaultModelId) {
    throw new Error(
      "INV-VIOLATION: server returned no valid default model for credit state"
    );
  }

  // Gate provider render: for existing threads, wait until messages are loaded.
  const isThreadLoading =
    !threadSession.sessionHydrated ||
    (threadSession.loadExisting && threadData.isPending);

  if (threadSession.loadExisting && threadData.isError) {
    const notFound =
      threadData.error instanceof ThreadFetchError &&
      threadData.error.status === 404;
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
        <div className="mx-auto w-full max-w-[var(--size-container-sm)] px-4">
          <ErrorAlert
            code={notFound ? "THREAD_NOT_FOUND" : "THREAD_LOAD_FAILED"}
            message={
              notFound
                ? "This conversation was not found. It may still be saving; retry or start a new chat."
                : "This conversation could not be loaded. Check your connection and retry."
            }
            retryable={true}
            showRetry={true}
            showSwitchFree={false}
            showAddCredits={false}
            onRetry={() => void threadData.refetch()}
          />
        </div>
      </div>
    );
  }

  // After the isThreadLoading gate, threadData.data is guaranteed for existing threads.
  const initialMessages: UIMessage[] =
    threadSession.loadExisting && threadData.data
      ? (threadData.data.messages as UIMessage[])
      : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {isThreadLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-muted-foreground">Loading thread...</div>
        </div>
      ) : (
        <ChatRuntimeProvider
          key={threadSession.runtimeKey}
          modelRef={selectedModelRef}
          selectedGraph={selectedGraph}
          defaultModelId={uiDefaultModelId}
          initialMessages={initialMessages}
          stateKey={threadSession.stateKey}
          onAuthExpired={() => signOut()}
          onError={handleError}
          onSettled={handleThreadSettled}
          onOptimisticSend={handleOptimisticSend}
        >
          <Thread
            welcomeMessage={<ChatWelcomeWithHint />}
            composerLeft={
              <ChatComposerExtras
                selectedModel={selectedModelRef.modelId}
                onModelChange={handleModelChange}
                defaultModelId={uiDefaultModelId}
                balance={balance}
                selectedGraph={selectedGraph}
                onGraphChange={handleGraphChange}
              />
            }
            errorMessage={
              errorAlertProps ? (
                <ChatErrorBubble
                  message={errorAlertProps.message}
                  // The provider's Failed status owns exact-envelope retry.
                  showRetry={false}
                  showSwitchFree={errorAlertProps.showSwitchFree}
                  showAddCredits={errorAlertProps.showAddCredits}
                  onSwitchFreeModel={handleSwitchFreeModel}
                  onAddCredits={handleAddCredits}
                />
              ) : undefined
            }
          />
        </ChatRuntimeProvider>
      )}
    </div>
  );
}
