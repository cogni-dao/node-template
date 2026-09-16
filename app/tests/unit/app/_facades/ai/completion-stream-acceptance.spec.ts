// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/ai/completion-stream-acceptance`
 * Purpose: Prove workflow acceptance is returned before Redis emits its first event.
 * Scope: Completion facade with mocked billing, Temporal, and RunStream ports.
 * Invariants: Temporal start is awaited; first-event timeout is an in-band terminal error.
 * Side-effects: none
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNoopLogger, type RequestContext } from "@/shared/observability";

const mocks = vi.hoisted(() => ({
  workflowStart: vi.fn().mockResolvedValue({}),
  subscribe: vi.fn(() =>
    (async function* () {
      await new Promise<never>(() => undefined);
    })()
  ),
}));

vi.mock("@/bootstrap/container", () => ({
  resolveAiAdapterDeps: () => ({ accountService: {} }),
  getTemporalWorkflowClient: async () => ({
    client: { start: mocks.workflowStart },
    taskQueue: "scheduler-tasks",
  }),
  getContainer: () => ({ runStream: { subscribe: mocks.subscribe } }),
}));

vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
    id: "billing-1",
    defaultVirtualKeyId: "vk-1",
  }),
}));

vi.mock("@/shared/config", () => ({ getNodeId: () => "node-template" }));

const ctx: RequestContext = {
  log: makeNoopLogger(),
  reqId: "request-1",
  traceId: "00000000000000000000000000000000",
  routeId: "ai.chat",
  clock: { now: () => "2025-01-01T00:00:00.000Z" },
};

describe("completionStream durable acceptance", () => {
  afterEach(() => vi.useRealTimers());

  it("scopes execution idempotency by node and billing account", async () => {
    const { scopeExecutionIdempotencyKey } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const callerKey = "chat:thread-1:message-1";

    const firstAccount = scopeExecutionIdempotencyKey(
      "node-template",
      "billing-1",
      callerKey
    );
    const secondAccount = scopeExecutionIdempotencyKey(
      "node-template",
      "billing-2",
      callerKey
    );

    expect(firstAccount).not.toBe(secondAccount);
    expect(firstAccount).toBe(
      scopeExecutionIdempotencyKey("node-template", "billing-1", callerKey)
    );
  });

  it("returns after Temporal start without awaiting the first Redis event", async () => {
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );

    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        stateKey: "thread-1",
        messageId: "message-1",
        serverRunId: "123e4567-e89b-42d3-a456-426614174000",
        idempotencyKey: "chat:thread-1:message-1",
        acceptanceMode: "workflow-start",
      },
      ctx
    );

    expect(mocks.workflowStart).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(accepted.runId).toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  it("emits the first-event deadline as an in-band timeout", async () => {
    vi.useFakeTimers();
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        acceptanceMode: "workflow-start",
      },
      ctx
    );

    const nextEvent = accepted.stream[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: { type: "error", error: "timeout" },
    });
  });

  it("treats subscriber abort as detach without stream-ended failure", async () => {
    const abortController = new AbortController();
    const warn = vi.spyOn(ctx.log, "warn");
    mocks.subscribe.mockImplementationOnce((_runId, signal: AbortSignal) =>
      (async function* () {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })()
    );
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        acceptanceMode: "workflow-start",
        abortSignal: abortController.signal,
      },
      ctx
    );

    const nextEvent = accepted.stream[Symbol.asyncIterator]().next();
    abortController.abort();

    await expect(nextEvent).resolves.toEqual({ done: true, value: undefined });
    await expect(accepted.final).resolves.toMatchObject({
      ok: false,
      error: "aborted",
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "stream_ended_no_terminal" }),
      expect.anything()
    );
  });
});
