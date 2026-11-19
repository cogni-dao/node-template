// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/ai/completion-connection-gate.spec`
 * Purpose: CONNECT_FROM_HOME at the run seam (story.0038). A run billed to a connected customer's record (a live payer row names it) is refused BEFORE any run claim, Temporal start or stream,
 *   with the gate's plain code; an ordinary payer (the caller's own account) never reaches the gate; the gate reads the standing for exactly the billed account.
 *   The routes map the typed refusal through the one error mapper (`connectionRefusalToHttpStatus`, `connectionRefusalToOpenAiError`).
 * Scope: The completion facade with mocked billing, payer and gate ports. No database, no network.
 * Side-effects: none
 */

import { ConnectionRefusedError } from "@cogni/agent-grants";
import { TEST_SESSION_USER_1 } from "@tests/_fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectionRefusalToHttpStatus, connectionRefusalToOpenAiError } from "@/app/_facades/ai/execution-error-mapper";
import { makeNoopLogger, type RequestContext } from "@/shared/observability";

const mocks = vi.hoisted(() => {
  const claims = new Map<string, { requestHash: string; runId: string }>();
  return {
    boundTo: null as string | null,
    claims,
    assertAdmits: vi.fn(),
    workflowStart: vi.fn().mockResolvedValue({}),
    checkIdempotency: vi.fn(async (key: string, requestHash: string) => {
      const existing = claims.get(key);
      return existing ? { status: "pending" as const, request: { ...existing, requestHash, idempotencyKey: key } } : { status: "new" as const };
    }),
    createPendingRequest: vi.fn(async (key: string, requestHash: string, runId: string) => {
      claims.set(key, { requestHash, runId });
    }),
  };
});

vi.mock("@/bootstrap/container", () => ({
  resolveAiAdapterDeps: () => ({ accountService: {} }),
  getTemporalWorkflowClient: async () => ({ client: { start: mocks.workflowStart }, taskQueue: "scheduler-tasks" }),
  getContainer: () => ({
    runStream: { subscribe: () => (async function* () { await new Promise<never>(() => undefined); })() },
    agentAuthority: { payerFor: async () => mocks.boundTo },
    serviceAccountService: {
      getBillingAccountById: async (id: string) => ({ id, ownerUserId: "org-user", defaultVirtualKeyId: "vk-org" }),
    },
    connections: { assertAdmits: mocks.assertAdmits },
    log: { info: () => undefined },
    executionRequestPort: { checkIdempotency: mocks.checkIdempotency, createPendingRequest: mocks.createPendingRequest },
  }),
}));
vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({ id: "billing-own", defaultVirtualKeyId: "vk-own" }),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => "node-template" }));
vi.mock("@/shared/env", () => ({ serverEnv: () => ({ AUTH_SECRET: "stable-completion-idempotency-secret", DEPLOY_ENVIRONMENT: "production", COGNI_LOCAL_INPROC: undefined }) }));

const ctx: RequestContext = {
  log: makeNoopLogger(),
  reqId: "request-1",
  traceId: "00000000000000000000000000000000",
  routeId: "ai.chat",
  clock: { now: () => "2025-01-01T00:00:00.000Z" },
};

const input = {
  messages: [{ role: "user" as const, content: "hello" }],
  modelRef: { providerKey: "platform" as const, modelId: "test-model" },
  sessionUser: TEST_SESSION_USER_1,
  graphName: "langgraph:default",
  idempotencyKey: "caller-key",
  acceptanceMode: "workflow-start" as const,
};

describe("completionStream connection gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claims.clear();
    mocks.boundTo = null;
    mocks.assertAdmits.mockResolvedValue(undefined);
  });

  it.each(["connection_cap_reached", "connection_allowance_empty", "connection_suspended", "connection_disconnected"] as const)(
    "a run billed to a connected record that the gate refuses (%s) throws the typed refusal and starts nothing",
    async (code) => {
      mocks.boundTo = "acct-record";
      mocks.assertAdmits.mockRejectedValue(new ConnectionRefusedError(code));
      const { completionStream } = await import("@/app/_facades/ai/completion.server");
      const refused = await completionStream(input, ctx).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ConnectionRefusedError);
      expect((refused as ConnectionRefusedError).code).toBe(code);
      expect(mocks.assertAdmits).toHaveBeenCalledWith("acct-record");
      // Refused before the run claim, the Temporal start and the stream.
      expect(mocks.checkIdempotency).not.toHaveBeenCalled();
      expect(mocks.createPendingRequest).not.toHaveBeenCalled();
      expect(mocks.workflowStart).not.toHaveBeenCalled();
    }
  );

  it("a record that admits the run lets it proceed to the run claim", async () => {
    mocks.boundTo = "acct-record";
    const { completionStream } = await import("@/app/_facades/ai/completion.server");
    await completionStream(input, ctx);
    expect(mocks.assertAdmits).toHaveBeenCalledWith("acct-record");
    expect(mocks.checkIdempotency).toHaveBeenCalled();
    expect(mocks.workflowStart).toHaveBeenCalledOnce();
  });

  it("an ordinary payer (the caller's own account, or a binding naming the caller's own account) never reaches the gate", async () => {
    const { completionStream } = await import("@/app/_facades/ai/completion.server");
    await completionStream(input, ctx);
    mocks.boundTo = "billing-own";
    await completionStream({ ...input, idempotencyKey: "other-key" }, ctx);
    expect(mocks.assertAdmits).not.toHaveBeenCalled();
  });
});

describe("the one error mapper for a connection refusal", () => {
  it("an exhausted allowance or a reached cap is 402 and a Suspend or Disconnect is 403, on the chat route", () => {
    expect(connectionRefusalToHttpStatus("connection_cap_reached")).toBe(402);
    expect(connectionRefusalToHttpStatus("connection_allowance_empty")).toBe(402);
    expect(connectionRefusalToHttpStatus("connection_suspended")).toBe(403);
    expect(connectionRefusalToHttpStatus("connection_disconnected")).toBe(403);
  });

  it("the OpenAI-compatible route carries the plain code and the same statuses", () => {
    expect(connectionRefusalToOpenAiError("connection_cap_reached")).toMatchObject({ status: 402, type: "insufficient_quota", code: "connection_cap_reached" });
    expect(connectionRefusalToOpenAiError("connection_suspended")).toMatchObject({ status: 403, code: "connection_suspended" });
  });
});
