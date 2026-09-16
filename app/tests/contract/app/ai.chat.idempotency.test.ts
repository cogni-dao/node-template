// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.chat.idempotency`
 * Purpose: Prove accepted chat retries cannot append duplicate or mutated user turns.
 * Scope: Chat route with in-memory thread persistence and mocked completion facade.
 * Invariants: exact envelope replay is a no-op; identity reuse with changed content is 409.
 * Side-effects: none
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let thread: UIMessage[] = [];
const saveThread = vi.fn(
  async (
    _userId: string,
    _stateKey: string,
    messages: UIMessage[],
    expected: number
  ) => {
    if (thread.length !== expected) throw new Error("unexpected test conflict");
    thread = messages;
  }
);

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: {
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    },
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    threadPersistenceForUser: () => ({
      loadThread: vi.fn(async () => thread),
      saveThread,
      softDelete: vi.fn(),
      listThreads: vi.fn(),
    }),
  }),
}));

vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attributes: unknown,
    handler: (value: { traceId: string; span: { setAttribute: () => void } }) =>
      Promise<unknown>
  ) => handler({ traceId: "trace-1", span: { setAttribute: vi.fn() } }),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

const completionStream = vi.fn(async (input: { runId?: string }) => ({
  stream: (async function* () {
    yield { type: "assistant_final" as const, content: "ok" };
    yield { type: "done" as const };
  })(),
  final: Promise.resolve({
    ok: true as const,
    requestId: input.runId ?? "run",
    usage: { promptTokens: 1, completionTokens: 1 },
    finishReason: "stop",
  }),
  runId: input.runId ?? "123e4567-e89b-42d3-a456-426614174000",
  workflowId: "graph-run:billing:chat:thread-1:message-1",
}));

vi.mock("@/app/_facades/ai/completion.server", () => ({ completionStream }));

import { POST } from "@/app/api/v1/ai/chat/route";

const base = {
  modelRef: { providerKey: "platform", modelId: "test-model" },
  graphName: "langgraph:default",
  stateKey: "thread-1",
  messageId: "message-1",
  runId: "123e4567-e89b-42d3-a456-426614174000",
};

async function send(message: string) {
  const response = await POST(
    new NextRequest("http://localhost/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, message }),
    })
  );
  if (response.status === 200) await response.text();
  return response;
}

describe("POST /api/v1/ai/chat idempotency", () => {
  beforeEach(() => {
    thread = [];
    vi.clearAllMocks();
  });

  it("suppresses an exact retry and returns stable discovery headers", async () => {
    const first = await send("hello");
    const retry = await send("hello");

    expect(first.headers.get("X-State-Key")).toBe("thread-1");
    expect(first.headers.get("X-Run-Id")).toBe(base.runId);
    expect(retry.status).toBe(200);
    expect(thread.filter((message) => message.role === "user")).toHaveLength(1);
    expect(saveThread).toHaveBeenCalledOnce();
  });

  it("returns discovery headers while the first graph event is still deferred", async () => {
    let releaseFirstEvent: (() => void) | undefined;
    completionStream.mockImplementationOnce(async (input) => ({
      stream: (async function* () {
        await new Promise<void>((resolve) => {
          releaseFirstEvent = resolve;
        });
        yield { type: "done" as const };
      })(),
      final: Promise.resolve({
        ok: true as const,
        requestId: input.runId ?? "run",
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "stop",
      }),
      runId: input.runId ?? base.runId,
      workflowId: "graph-run:accepted",
    }));

    const response = await POST(
      new NextRequest("http://localhost/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, message: "deferred" }),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-State-Key")).toBe(base.stateKey);
    expect(response.headers.get("X-Run-Id")).toBe(base.runId);
    expect(thread).toHaveLength(1);
    await vi.waitFor(() => expect(releaseFirstEvent).toBeTypeOf("function"));
    releaseFirstEvent?.();
    await response.text();
  });

  it("rejects reuse of messageId with changed content", async () => {
    await send("original");
    const mismatch = await send("mutated");

    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      error: "Message identity already exists with different content",
    });
    expect(thread).toHaveLength(1);
  });
});
