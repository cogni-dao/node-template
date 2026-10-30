// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/internal.graphs-run-terminal`
 * Purpose: Prove failed terminal publication finalizes the accepted execution as failed.
 * Scope: Internal graph-run route with mocked executor, persistence, stream, and idempotency ports.
 * Invariants: rejected done publication cannot produce a successful execution record.
 * Side-effects: none
 * @internal
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_ID = "a0000000-0000-4000-a000-000000000001";
const USER_ID = "10000000-0000-4000-a000-000000000001";
const BILLING_ID = "20000000-0000-4000-a000-000000000001";
const VIRTUAL_KEY_ID = "30000000-0000-4000-a000-000000000001";

const mocks = vi.hoisted(() => ({
  runGraph: vi.fn(),
  checkIdempotency: vi.fn().mockResolvedValue({ status: "new" }),
  createPendingRequest: vi.fn().mockResolvedValue({
    status: "claimed",
    request: { runId: "a0000000-0000-4000-a000-000000000001" },
  }),
  heartbeatRequest: vi.fn().mockResolvedValue(undefined),
  finalizeRequest: vi.fn(),
  markRunCompleted: vi.fn().mockResolvedValue(undefined),
  getRunByRunId: vi.fn().mockResolvedValue(null),
  publish: vi.fn(async (_runId: string, event: { type: string }) => {
    if (event.type === "done") throw new Error("redis unavailable");
  }),
  saveThread: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_options: unknown, handler: (...args: never[]) => unknown) =>
    (request: NextRequest, context?: unknown) =>
      handler(
        {
          reqId: "request-1",
          traceId: "00000000000000000000000000000001",
          routeId: "graphs.run.internal",
          clock: { now: () => "2025-01-01T00:00:00.000Z" },
          log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
        } as never,
        request as never,
        null as never,
        context as never
      ),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ SCHEDULER_API_TOKEN: "scheduler-secret-value-1234567890" }),
}));

vi.mock("@/bootstrap/graph-executor.factory", () => {
  const executor = {
    runGraph: mocks.runGraph.mockImplementation(() => ({
      stream: (async function* () {
        yield { type: "assistant_final" as const, content: "answer" };
        yield { type: "done" as const };
      })(),
      final: Promise.resolve({
        ok: true as const,
        requestId: "a0000000-0000-4000-a000-000000000001",
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: "stop" as const,
      }),
    })),
  };
  return {
    createGraphExecutor: () => executor,
    createScopedGraphExecutor: () => executor,
  };
});

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    executionRequestPort: {
      checkIdempotency: mocks.checkIdempotency,
      createPendingRequest: mocks.createPendingRequest,
      heartbeatRequest: mocks.heartbeatRequest,
      finalizeRequest: mocks.finalizeRequest,
    },
    graphRunRepository: {
      markRunCompleted: mocks.markRunCompleted,
      getRunByRunId: mocks.getRunByRunId,
    },
    accountsForUser: () => ({}),
    executionGrantWorkerPort: { validateGrantForGraph: vi.fn().mockResolvedValue({ userId: USER_ID, billingAccountId: BILLING_ID }) },
    serviceAccountService: { getBillingAccountById: vi.fn().mockResolvedValue({ defaultVirtualKeyId: VIRTUAL_KEY_ID }) },
    providerResolver: {},
    connectionBroker: undefined,
    runStream: {
      publish: mocks.publish,
      expire: vi.fn().mockResolvedValue(undefined),
    },
    threadPersistenceForUser: () => ({
      loadThread: vi.fn().mockResolvedValue([
        { id: "message-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      ]),
      saveThread: mocks.saveThread,
      softDelete: vi.fn(),
      listThreads: vi.fn(),
    }),
  }),
}));

import { POST } from "@/app/api/internal/graphs/[graphId]/runs/route";

describe("POST /api/internal/graphs/{graphId}/runs terminal publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkIdempotency.mockResolvedValue({ status: "new" });
    mocks.getRunByRunId.mockResolvedValue(null);
  });

  it.each(["cogni-decide", "work-prioritizer"])("defaults API %s to answer and permits a validated schedule", async (graph) => {
    for (const scheduled of [false, true]) {
      mocks.runGraph.mockClear();
      mocks.getRunByRunId.mockResolvedValue(scheduled ? { runKind: "system_scheduled", triggerSource: "temporal_schedule", graphId: `langgraph:${graph}`, triggerRef: "schedule", scheduledFor: new Date("2026-01-01T00:00:00.000Z") } : null);
      await POST(new NextRequest(`http://localhost/api/internal/graphs/langgraph:${graph}/runs`, {
        method: "POST",
        headers: { authorization: "Bearer scheduler-secret-value-1234567890", "content-type": "application/json", "idempotency-key": scheduled ? "schedule:2026-01-01T00:00:00.000Z" : "api:test" },
        body: JSON.stringify({ executionGrantId: scheduled ? "40000000-0000-4000-a000-000000000001" : null, runId: RUN_ID, input: { messages: [{ role: "user", content: "decide" }], modelRef: { providerKey: "platform", modelId: "test-model" }, actorUserId: USER_ID, billingAccountId: BILLING_ID, virtualKeyId: VIRTUAL_KEY_ID } }),
      }), { params: Promise.resolve({ graphId: `langgraph:${graph}` }) });
      expect(mocks.runGraph).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestIntent: scheduled ? "decide" : "answer" }));
    }
  });

  it.each([
    { runKind: "system_webhook", triggerSource: "webhook", graphId: "langgraph:cogni-decide", triggerRef: "schedule", scheduledFor: new Date("2026-01-01T00:00:00.000Z") },
    { runKind: "system_scheduled", triggerSource: "temporal_schedule", graphId: "langgraph:other", triggerRef: "schedule", scheduledFor: new Date("2026-01-01T00:00:00.000Z") },
    null,
  ])("defaults unverified grant-backed runs to answer", async (record) => {
    mocks.getRunByRunId.mockResolvedValue(record);
    await POST(new NextRequest("http://localhost/api/internal/graphs/langgraph:cogni-decide/runs", {
      method: "POST", headers: { authorization: "Bearer scheduler-secret-value-1234567890", "content-type": "application/json", "idempotency-key": "schedule:2026-01-01T00:00:00.000Z" },
      body: JSON.stringify({ executionGrantId: "40000000-0000-4000-a000-000000000001", runId: RUN_ID, input: { messages: [{ role: "user", content: "decide" }], modelRef: { providerKey: "platform", modelId: "test-model" } } }),
    }), { params: Promise.resolve({ graphId: "langgraph:cogni-decide" }) });
    expect(mocks.runGraph).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestIntent: "answer" }));
  });

  it("finalizes failure when durable done publication rejects", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/internal/graphs/langgraph:default/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer scheduler-secret-value-1234567890",
            "content-type": "application/json",
            "idempotency-key": "ai:scoped-key",
          },
          body: JSON.stringify({
            executionGrantId: null,
            runId: RUN_ID,
            input: {
              messages: [{ role: "user", content: "hello" }],
              modelRef: { providerKey: "platform", modelId: "test-model" },
              actorUserId: USER_ID,
              billingAccountId: BILLING_ID,
              virtualKeyId: VIRTUAL_KEY_ID,
              stateKey: "thread-1",
            },
          }),
        }
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      runId: RUN_ID,
      error: "internal",
    });
    expect(mocks.saveThread).toHaveBeenCalledOnce();
    expect(mocks.finalizeRequest).toHaveBeenCalledWith("ai:scoped-key", {
      ok: false,
      errorCode: "internal",
    });
  });

  it("rejects a matching live pending run without executing it", async () => {
    const requestHash = "a".repeat(64);
    mocks.checkIdempotency.mockResolvedValue({
      status: "pending",
      request: {
        idempotencyKey: "ai:scoped-key",
        requestHash,
        runId: RUN_ID,
        traceId: null,
        ok: null,
        errorCode: null,
        createdAt: new Date(),
      },
    });

    const response = await POST(
      new NextRequest(
        "http://localhost/api/internal/graphs/langgraph:default/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer scheduler-secret-value-1234567890",
            "content-type": "application/json",
            "idempotency-key": "ai:scoped-key",
          },
          body: JSON.stringify({
            executionGrantId: null,
            runId: RUN_ID,
            input: {
              messages: [{ role: "user", content: "hello" }],
              modelRef: { providerKey: "platform", modelId: "test-model" },
              actorUserId: USER_ID,
              billingAccountId: BILLING_ID,
              virtualKeyId: VIRTUAL_KEY_ID,
              stateKey: "thread-1",
              executionRequestHash: requestHash,
            },
          }),
        }
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) }
    );

    expect(response.status).toBe(409);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.heartbeatRequest).not.toHaveBeenCalled();
    expect(mocks.finalizeRequest).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });
});
