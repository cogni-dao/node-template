// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Canonical admission and presentation: provisional graph text never escapes. */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { completionRequestHash } from "@/app/_lib/ai/completion-identity";
import { workItemSemanticIdentity } from "../../../packages/ai-tools/src/work-item-semantic";
import { persistAssistantThenPublishTerminal } from "../../../packages/graph-execution-host/src/durable-chat-terminal";
import {
  canonicalTerminal,
  completeManagedGraph,
  publishCanonicalTerminal,
  shouldWithholdResultEvent,
} from "../../../packages/graph-execution-host/src/managed-execution";
import { freezeMissionEvidence } from "../../../packages/langgraph-graphs/src/graphs/work-prioritizer/frozen-evidence";
import { parseMissionEvidenceResult } from "../../../packages/langgraph-graphs/src/graphs/work-prioritizer/program";

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
  it("refuses a prior reference to an incomplete artifact", () => {
    expect(() =>
      canonicalTerminal(
        candidate,
        {
          ...candidate,
          structuredOutput: {
            status: "incomplete",
            reason: "missing_evidence",
          },
        },
        hash
      )
    ).toThrow("invalid_prior_result");
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

const itemSource = "https://node.example/work/items/task.1";
const fullItem = {
  id: "task.1",
  type: "task",
  title: "Build mission",
  status: "needs_implement",
  actor: "ai",
  summary: "a".repeat(620),
  outcome: "Useful outcome",
  revision: 7,
  updatedAt: "2026-01-01",
  labels: ["b", "a"],
  assignees: [{ kind: "agent" as const, id: "builder" }],
  scores: { goal: { v: 1, ev: "https://node.example/knowledge/goal-1" } },
};
async function captureInput(item = fullItem) {
  return {
    evidence: [
      {
        id: "e1",
        tool: "core__goal_list",
        args: {},
        sha256: "a".repeat(64),
        value: {
          goals: [
            {
              id: "goal-1",
              title: "Mission",
              content: "KPI: ship",
              evaluateAt: "2030-01-01",
              sourceUrl: "https://node.example/knowledge/goal-1",
            },
          ],
        },
      },
      {
        id: "e2",
        tool: "core__work_item_query",
        args: { limit: 5 },
        sha256: "b".repeat(64),
        value: {
          items: [
            {
              ...item,
              summary: item.summary.slice(0, 600),
              sourceUrl: itemSource,
              semanticIdentity: await workItemSemanticIdentity(item, {
                sourceUrl: itemSource,
              }),
            },
          ],
          count: 1,
          paginationKnown: true,
          nextCursor: "opaque-cursor",
        },
      },
    ],
    sources: [
      {
        id: "mission-loop-expert",
        content: "Serve mission",
        entryType: "skill",
        tags: ["expertise-role"],
        sourceRef: "commit-a",
      },
    ],
    task: "Review the mission backlog",
    now: Date.parse("2029-01-01"),
  };
}
describe("closed recurring mission evidence", () => {
  it("ignores counters/order but detects complete hidden tails and substantive fields", async () => {
    const original = await workItemSemanticIdentity(fullItem, {
      sourceUrl: itemSource,
    });
    expect(
      await workItemSemanticIdentity(
        { ...fullItem, revision: 9, updatedAt: "later", labels: ["a", "b"] },
        { sourceUrl: itemSource }
      )
    ).toEqual(original);
    for (const delta of [
      { summary: `${fullItem.summary}changed beyond excerpt` },
      { actor: "human" },
      { assignees: [{ kind: "agent" as const, id: "other" }] },
      { pr: "https://github.com/example/repo/pull/2" },
      { scores: { goal: { v: 2 } } },
    ]) {
      expect(
        await workItemSemanticIdentity(
          { ...fullItem, ...delta },
          { sourceUrl: itemSource }
        )
      ).not.toEqual(original);
    }
    const a = freezeMissionEvidence(await captureInput());
    const b = freezeMissionEvidence(
      await captureInput({
        ...fullItem,
        revision: 8,
        updatedAt: "later",
        labels: ["a", "b"],
      })
    );
    expect(a.inputIdentity).toEqual(b.inputIdentity);
    expect(
      freezeMissionEvidence(
        await captureInput({
          ...fullItem,
          summary: `${fullItem.summary}hidden`,
        })
      ).inputIdentity
    ).not.toEqual(a.inputIdentity);
  });
  it("rereads frozen versions and refuses uncaptured dependencies", async () => {
    const input = await captureInput();
    const captured = freezeMissionEvidence(input);
    input.evidence[1]!.value.items![0]!.title = "changed live";
    const reread = captured.read("core__work_item_query", {
      ids: ["task.1"],
    }) as { items: Record<string, unknown>[] };
    expect(reread.items[0]?.title).toBe("Build mission");
    expect(reread.items[0]).not.toHaveProperty("revision");
    expect(reread.items[0]).not.toHaveProperty("updatedAt");
    for (const [tool, args] of [
      ["core__knowledge_read", { id: "new-source" }],
      ["core__work_item_query", { ids: ["task.other"] }],
      ["core__work_item_query", { limit: 20 }],
      ["core__get_current_time", {}],
    ] as const) {
      expect(() => captured.read(tool, args)).toThrow("outside_snapshot");
    }
    const proposal = captured.finalizeProposal({
      payload: { items: [{ id: "task.1", expectedRevision: 999 }] },
    }) as { payload: { items: { expectedRevision: number }[] } };
    expect(proposal.payload.items[0]?.expectedRevision).toBe(7);
    expect(JSON.stringify(captured.sources)).not.toContain("commit-a");
  });
  it("binds task/guidance/deadline state and rejects unknown coverage", async () => {
    const input = await captureInput();
    const original = freezeMissionEvidence(input).inputIdentity;
    expect(
      freezeMissionEvidence({ ...input, task: "Different task" }).inputIdentity
    ).not.toEqual(original);
    expect(
      freezeMissionEvidence({ ...input, now: Date.parse("2031-01-01") })
        .inputIdentity
    ).not.toEqual(original);
    expect(
      freezeMissionEvidence({
        ...input,
        sources: [{ ...input.sources[0]!, content: "Changed mission" }],
      }).inputIdentity
    ).not.toEqual(original);
    input.evidence[1]!.value.paginationKnown = false;
    expect(() => freezeMissionEvidence(input)).toThrow(
      "snapshot_coverage_unknown"
    );
  });
  it("canonical parser accepts host prior-result no-op and rejects invented acceptance", () => {
    const output = {
      version: 1,
      program: { id: "mission-prioritization", version: "4" },
      runId: "run-b",
      status: "no_op",
      reason: "unchanged_input",
      priorResult: { runId: "run-a", sha256: "a".repeat(64) },
      guidance: [],
      evidence: [],
      roles: [],
      revisions: 0,
      budget: { modelCalls: 1, toolCalls: 1, inputBytes: 1, toolBytes: 1 },
      telemetry: {
        changeCount: 0,
        changedItemIds: [],
        aborted: false,
        report: "unchanged_input",
      },
    };
    expect(parseMissionEvidenceResult(output)).toEqual(output);
    expect(() =>
      parseMissionEvidenceResult({ ...output, status: "accepted" })
    ).toThrow();
  });
  it("receiver request fingerprint rejects altered content, model and thread", () => {
    const payload = {
      graphId: "langgraph:work-prioritizer",
      messages: [{ role: "user" as const, content: "Review mission" }],
      modelRef: { providerKey: "openrouter", modelId: "model" },
      stateKey: "thread-a",
    };
    const signed = completionRequestHash(payload, "test-key");
    expect(
      completionRequestHash(
        {
          ...payload,
          modelRef: { modelId: "model", providerKey: "openrouter" },
        },
        "test-key"
      )
    ).toBe(signed);
    expect(
      completionRequestHash({ ...payload, stateKey: "thread-b" }, "test-key")
    ).not.toBe(signed);
    expect(
      completionRequestHash(
        { ...payload, messages: [{ role: "user", content: "Changed" }] },
        "test-key"
      )
    ).not.toBe(signed);
    expect(
      completionRequestHash(
        { ...payload, modelRef: { ...payload.modelRef, modelId: "different" } },
        "test-key"
      )
    ).not.toBe(signed);
  });
});
