// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Canonical admission and presentation: provisional graph text never escapes. */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { persistAssistantThenPublishTerminal } from "../../../packages/graph-execution-host/src/durable-chat-terminal";
import {
  canonicalTerminal,
  completeManagedGraph,
  publishCanonicalTerminal,
  shouldWithholdResultEvent,
} from "../../../packages/graph-execution-host/src/managed-execution";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const audience = {
  actorUserId: "owner",
  billingAccountId: "billing",
  graphId: "langgraph:mission",
  executionGrantId: null,
};
const accepted = {
  version: 1,
  status: "accepted",
  runId: "run-a",
  proposal: { scores: [1, 2] },
};
const candidate = {
  version: 1 as const,
  audience,
  runId: "run-a",
  traceId: "trace-a",
  stateKey: "thread-a",
  ok: true as const,
  structuredOutput: accepted,
};
describe("canonical result admission", () => {
  it("equal input admits a prior reference without retaining a duplicate proposal", () => {
    const first = canonicalTerminal(candidate, undefined, hash);
    const second = canonicalTerminal(
      {
        ...candidate,
        runId: "run-b",
        structuredOutput: {
          ...accepted,
          runId: "run-b",
          proposal: { scores: [5, 5] },
        },
      },
      first,
      hash
    );
    expect(second.structuredOutput).toMatchObject({
      status: "no_op",
      reason: "unchanged_input",
      priorResult: { runId: "run-a", sha256: hash(JSON.stringify(first)) },
    });
    expect(second.structuredOutput).not.toHaveProperty("proposal");
    expect(first.structuredOutput).toEqual(accepted);
  });
  it("withholds provisional accepted text, final and done while draining usage", () => {
    for (const type of ["text_delta", "assistant_final", "done"])
      expect(shouldWithholdResultEvent(type)).toBe(true);
    for (const type of ["usage_report", "tool_call_result"])
      expect(shouldWithholdResultEvent(type)).toBe(false);
  });
  it("delivery failure cannot mutate committed canonical output", async () => {
    const saved = canonicalTerminal(candidate, undefined, hash);
    const publish = vi.fn().mockRejectedValue(new Error("redis lost"));
    const persist = vi.fn().mockResolvedValue(undefined);
    await expect(
      publishCanonicalTerminal(saved, { persist, publish })
    ).rejects.toThrow("redis lost");
    expect(persist).toHaveBeenCalledWith(
      JSON.stringify(saved.structuredOutput)
    );
    expect(saved.ok).toBe(true);
    expect(saved.structuredOutput).toEqual(accepted);
  });
  it("rejects oversized and cross-audience duplicate results", () => {
    expect(() =>
      canonicalTerminal(
        { ...candidate, structuredOutput: { x: "a".repeat(40_000) } },
        undefined,
        hash
      )
    ).toThrow("result_too_large");
    expect(() =>
      canonicalTerminal(
        candidate,
        { ...candidate, audience: { ...audience, actorUserId: "other" } },
        hash
      )
    ).toThrow("result_audience_mismatch");
  });
  it("rejects a same-ID presentation that disagrees with canonical content", async () => {
    const publish = vi.fn();
    await expect(
      persistAssistantThenPublishTerminal(
        {
          runId: "r",
          stateKey: "s",
          actorUserId: "u",
          accumulatedEvents: [],
          verifyExistingContent: true,
          threadPersistenceForUser: () => ({
            loadThread: async () => [
              {
                id: "assistant-r",
                role: "assistant",
                parts: [{ type: "text", text: "stale accepted" }],
              },
            ],
            saveThread: vi.fn(),
          }),
          publishTerminal: publish,
        },
        {
          assembleAssistantMessage: () => ({
            id: "assistant-r",
            role: "assistant",
            parts: [{ type: "text", text: "canonical no_op" }],
          }),
          redactSecretsInMessages: (messages) => messages,
          isThreadConflictError: () => false,
        }
      )
    ).rejects.toThrow("canonical_presentation_mismatch");
    expect(publish).not.toHaveBeenCalled();
  });
  it("drains a stale receiver but publishes none of its accepted JSON", async () => {
    let drained = false;
    const publish = vi.fn();
    const persist = vi.fn();
    const commit = vi.fn(async () => {
      expect(drained).toBe(true);
      return { status: "stale" as const };
    });
    const result = await completeManagedGraph({
      run: {
        stream: (async function* () {
          yield {
            type: "text_delta" as const,
            delta: JSON.stringify(accepted),
          };
          yield {
            type: "assistant_final" as const,
            content: JSON.stringify(accepted),
          };
          yield { type: "done" as const };
          drained = true;
        })(),
        final: Promise.resolve({
          ok: true,
          runId: "run-a",
          requestId: "run-a",
          structuredOutput: accepted,
          inputIdentity: { policyVersion: "frozen-v1", digest: "a".repeat(64) },
        }),
      },
      claim: {
        token: "token",
        graphRunId: "row",
        binding: {
          idempotencyKey: "key",
          requestHash: "hash",
          runId: "run-a",
          audience,
        },
      },
      port: { commit },
      traceId: null,
      scope: {
        nodeId: "node",
        environment: "candidate-a",
        scheduleId: "schedule",
      },
      parseResult: (v) => v as Record<string, unknown>,
      hash,
      persist,
      publish,
      onDeliveryError: vi.fn(),
    });
    expect(result).toEqual({ status: "stale" });
    expect(persist).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it("missing trusted input identity persists named incomplete, never accepted", async () => {
    const publish = vi.fn();
    const commit = vi.fn(async (_claim, input) => {
      expect(input.acceptedInputKey).toBeUndefined();
      return { status: "committed" as const, result: input.resolve() };
    });
    const result = await completeManagedGraph({
      run: {
        stream: (async function* () {
          yield { type: "text_delta" as const, delta: "provisional accepted" };
          yield { type: "done" as const };
        })(),
        final: Promise.resolve({
          ok: true,
          runId: "run-a",
          requestId: "run-a",
          structuredOutput: accepted,
        }),
      },
      claim: {
        token: "token",
        graphRunId: "row",
        binding: {
          idempotencyKey: "key",
          requestHash: "hash",
          runId: "run-a",
          audience,
        },
      },
      port: { commit },
      traceId: null,
      scope: {
        nodeId: "node",
        environment: "candidate-a",
        scheduleId: "schedule",
      },
      parseResult: (v) => v as Record<string, unknown>,
      hash,
      persist: vi.fn(),
      publish,
      onDeliveryError: vi.fn(),
    });
    expect(result).toMatchObject({
      status: "committed",
      result: {
        structuredOutput: {
          status: "incomplete",
          reason: "input_identity_missing",
        },
      },
    });
    expect(JSON.stringify(publish.mock.calls)).not.toContain(
      "provisional accepted"
    );
    expect(JSON.stringify(publish.mock.calls)).not.toContain('"proposal"');
  });
});
