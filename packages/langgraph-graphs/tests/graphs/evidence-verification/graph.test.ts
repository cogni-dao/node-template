// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { createHash } from "node:crypto";
import {
  GOAL_LIST_NAME,
  goalListContract,
  KNOWLEDGE_READ_NAME,
  knowledgeReadContract,
  WORK_ITEM_TRANSITION_NAME,
  workItemTransitionContract,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEvidenceVerificationGraph,
  type EvidenceProgram,
} from "../../../src/graphs/evidence-verification/graph";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn, CompletionResult } from "../../../src/inproc/types";

const body =
  "An unresolved human gate means defer, never approve. Full UTF-8 principle: ✓";
const program: EvidenceProgram = {
  id: "review",
  version: "test-1",
  requiredSources: [{ id: "review-skill", kind: "skill" }],
  readToolIds: [KNOWLEDGE_READ_NAME, GOAL_LIST_NAME],
  initialReads: [{ tool: GOAL_LIST_NAME, args: {} }],
  assignment: "Review current evidence.",
  criteria: "Follow the exact principle and primary evidence.",
  payloadSchema: z.object({ decision: z.enum(["approve", "defer"]) }).strict(),
  payloadDescription: '{decision:"approve"|"defer"}',
};
const proposal = (decision = "defer") =>
  JSON.stringify({
    kind: "proposal",
    summary: "Human gate remains",
    evidenceIds: ["e1"],
    payload: { decision },
  });
const accept = JSON.stringify({
  verdict: "accept",
  reason: "Supported by the primary evidence and required principle",
});
const revise = JSON.stringify({
  verdict: "revise",
  reason: "The required principle forbids approving unresolved human gates",
});
const text = (content: string): CompletionResult => ({ ok: true, content });
const toolCall = (name: string): CompletionResult => ({
  ok: true,
  toolCalls: [
    { id: "call-1", type: "function", function: { name, arguments: "{}" } },
  ],
});

export async function exercise(
  options: {
    program?: EvidenceProgram;
    replies?: CompletionResult[];
    source?: unknown;
    missingHost?: boolean;
    toolIds?: string[];
    complete?: (messages: string, call: number) => CompletionResult;
    slow?: boolean;
    usage?: boolean;
  } = {}
) {
  const calls: { messages: string; tools: string; model: string }[] = [];
  const executions: string[] = [];
  const events: unknown[] = [];
  const completionFn: CompletionFn = (req) => {
    const i = calls.length;
    calls.push({
      messages: JSON.stringify(req.messages),
      tools: JSON.stringify(req.tools),
      model: req.model,
    });
    const response =
      options.complete?.(JSON.stringify(req.messages), i) ??
      (options.replies ?? [
        text("Evidence: human approval is unresolved"),
        text(proposal()),
        text(accept),
      ])[i];
    if (!response) throw new Error("unexpected model call");
    return {
      stream: (async function* () {
        yield {
          type: "text_delta" as const,
          delta: response.content ?? "draft",
        };
        if (options.usage)
          yield {
            type: "usage_report" as const,
            fact: {
              runId: "root-1",
              attempt: 0,
              usageUnitId: `call-${i}`,
              source: "litellm" as const,
              executorType: "inproc" as const,
              graphId: "langgraph:work-prioritizer" as const,
              inputTokens: 10,
              outputTokens: 5,
            },
          };
      })(),
      final: options.slow
        ? new Promise((resolve) => setTimeout(() => resolve(response), 20))
        : Promise.resolve(response),
    };
  };
  const p = options.program ?? program;
  const runner = createInProcGraphRunner({
    createGraph: (opts) => createEvidenceVerificationGraph(opts, p),
    finalOnly: true,
    completionFn,
    toolContracts: [
      knowledgeReadContract,
      goalListContract,
      workItemTransitionContract,
    ],
    createToolExecFn: () => async (name) => {
      executions.push(name);
      if (name === KNOWLEDGE_READ_NAME)
        return {
          ok: true,
          value: options.source ?? {
            mode: "get",
            totalFound: 1,
            entries: [
              {
                id: "review-skill",
                content: body,
                sourceRef: "contribution:test:1",
                entryType: "skill",
                tags: ["expertise-role"],
              },
            ],
          },
        };
      if (name === GOAL_LIST_NAME)
        return {
          ok: true,
          value: {
            goals: [{ id: "goal-1", content: "human approval unresolved" }],
          },
        };
      throw new Error("a forbidden effect reached the runner");
    },
    request: {
      runId: "root-1",
      ...(options.missingHost ? {} : { nodeId: "node-1" }),
      messages: [
        { role: "user", content: "PRIVATE HISTORY" },
        { role: "assistant", content: "untrusted old claim" },
        { role: "user", content: "Review the open gate" },
      ],
      configurable: {
        model: "unchanged-model",
        toolIds: options.toolIds ?? [
          ...p.readToolIds,
          WORK_ITEM_TRANSITION_NAME,
        ],
      },
    },
  });
  for await (const event of runner.stream) events.push(event);
  return { result: await runner.final, calls, executions, events };
}

describe("evidence verification through the injected runner", () => {
  it("loads exact guidance, isolates child, verifies primary evidence and preserves typed final", async () => {
    const { result, calls, events } = await exercise();
    expect(result.ok).toBe(true);
    expect(result.structuredOutput).toMatchObject({
      status: "accepted",
      revisions: 0,
      guidance: [
        {
          nodeId: "node-1",
          id: "review-skill",
          sourceRef: "contribution:test:1",
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      ],
      budget: { modelCalls: 3, toolCalls: 2 },
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.model === "unchanged-model")).toBe(true);
    expect(calls[0]?.messages).not.toContain("PRIVATE HISTORY");
    expect(calls[0]?.messages).not.toContain("untrusted old claim");
    expect(calls[2]?.messages).toContain("human approval unresolved");
    expect(calls[2]?.messages).toContain(body);
    expect(calls[2]?.messages).not.toContain('"findings"');
    expect(JSON.parse(result.content ?? "null")).toEqual(
      result.structuredOutput
    );
    expect(events).toContainEqual({
      type: "assistant_final",
      content: result.content,
    });
    expect(
      events.filter((e) => (e as { type: string }).type === "text_delta")
    ).toEqual([{ type: "text_delta", delta: result.content }]);
    expect(result.usage).toBeUndefined(); // unknown remains unknown, not free
  });

  it.each([
    { mode: "get", totalFound: 0, entries: [] },
    { error: "authz_denied" },
    {
      mode: "get",
      totalFound: 1,
      entries: [
        {
          id: "review-skill",
          content: body,
          sourceRef: "r",
          entryType: "guide",
          tags: ["expertise-role"],
        },
      ],
    },
    {
      mode: "get",
      totalFound: 1,
      entries: [
        {
          id: "review-skill",
          content: body,
          sourceRef: "r",
          entryType: "skill",
          tags: ["expertise-role-other"],
        },
      ],
    },
    {
      mode: "get",
      totalFound: 1,
      entries: [
        {
          id: "review-skill",
          content: body,
          sourceRef: "r",
          entryType: "skill",
          tags: ["expertise-role"],
          truncated: true,
        },
      ],
    },
    {
      mode: "get",
      totalFound: 1,
      entries: [
        {
          id: "review-skill",
          content: "x".repeat(25_000),
          sourceRef: "r",
          entryType: "skill",
          tags: ["expertise-role"],
        },
      ],
    },
  ])("fails closed before any model for missing/denied/partial/oversized guidance", async (source) => {
    const { result, calls } = await exercise({ source });
    expect(result.structuredOutput?.status).toBe("incomplete");
    expect(calls).toHaveLength(0);
  });

  it("does not widen a denied host tool allowlist", async () => {
    const { result, calls, executions } = await exercise({
      toolIds: [GOAL_LIST_NAME],
    });
    expect(result.structuredOutput?.status).toBe("incomplete");
    expect(calls).toHaveLength(0);
    expect(executions).toHaveLength(0);
  });

  it("does not execute a model-requested write even when injected and host-allowed", async () => {
    const { result, executions, calls } = await exercise({
      replies: [toolCall(WORK_ITEM_TRANSITION_NAME)],
    });
    expect(result.structuredOutput).toMatchObject({
      status: "incomplete",
      reason: "tool_denied",
    });
    expect(executions).not.toContain(WORK_ITEM_TRANSITION_NAME);
    expect(calls[0]?.tools).not.toContain(WORK_ITEM_TRANSITION_NAME);
  });

  it("required principle changes a held-out verdict and permits one targeted revision", async () => {
    const { result, calls } = await exercise({
      complete(messages, call) {
        if (call === 0) return text("A human gate exists.");
        if (call === 1) return text(proposal("approve"));
        if (call === 2)
          return text(
            messages.includes(body) &&
              messages.includes("human approval unresolved")
              ? revise
              : accept
          );
        if (call === 3) return text(proposal("defer"));
        return text(accept);
      },
    });
    expect(result.structuredOutput).toMatchObject({
      status: "accepted",
      revisions: 1,
      proposal: { payload: { decision: "defer" } },
    });
    expect(calls).toHaveLength(5);
    expect(calls[3]?.messages).toContain("forbids approving");
  });

  it("second rejection remains incomplete and never emits the rejected proposal", async () => {
    const { result, calls } = await exercise({
      replies: [
        text("facts"),
        text(proposal()),
        text(revise),
        text(proposal()),
        text(revise),
      ],
    });
    expect(result.structuredOutput).toMatchObject({
      status: "incomplete",
      reason: "verification_rejected",
      revisions: 1,
    });
    expect(result.structuredOutput).not.toHaveProperty("proposal");
    expect(calls).toHaveLength(5);
  });

  it("bounds calls across child and verifier rather than resetting per role", async () => {
    const { result, calls } = await exercise({
      program: { ...program, limits: { modelCalls: 2 } },
    });
    expect(result.structuredOutput).toMatchObject({
      status: "incomplete",
      reason: "model_call_limit",
    });
    expect(calls).toHaveLength(2);
  });

  it("deadline prevents subsequent calls after one in-flight completion", async () => {
    const { result, calls } = await exercise({
      program: { ...program, limits: { deadlineMs: 5 } },
      slow: true,
    });
    expect(result.structuredOutput).toMatchObject({
      status: "incomplete",
      reason: "deadline_or_cancelled",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects invented evidence references before a verifier call", async () => {
    const { result, calls } = await exercise({
      replies: [text("facts"), text(proposal().replace("e1", "invented"))],
    });
    expect(result.structuredOutput?.reason).toBe(
      "unsupported_evidence_reference"
    );
    expect(calls).toHaveLength(2);
  });

  it("supports a materially different output schema without another factory", async () => {
    const second = {
      ...program,
      id: "knowledge-review",
      payloadSchema: z.object({ contradictions: z.array(z.string()) }).strict(),
      payloadDescription: "{contradictions:string[]}",
    };
    const content = JSON.stringify({
      kind: "no_change",
      summary: "No contradiction in supplied source",
      evidenceIds: ["e1"],
      payload: { contradictions: [] },
    });
    const { result } = await exercise({
      program: second,
      replies: [text("compared exact sources"), text(content), text(accept)],
    });
    expect(result.structuredOutput).toMatchObject({
      status: "no_op",
      program: { id: "knowledge-review" },
    });
    const invalid = await exercise({ program: second });
    expect(invalid.result.structuredOutput?.reason).toBe(
      "invalid_proposal_schema"
    );
  });
});

it("aggregates normal usage facts from child, author and verifier exactly once", async () => {
  const { result } = await exercise({ usage: true });
  expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 15 });
});
it("an actual isolated child tool call becomes primary evidence for the verifier", async () => {
  const { result, calls, executions } = await exercise({
    replies: [
      toolCall(GOAL_LIST_NAME),
      text("checked facts"),
      text(proposal()),
      text(accept),
    ],
  });
  expect(result.structuredOutput).toMatchObject({
    status: "accepted",
    evidence: [{ id: "e1" }, { id: "e2" }],
  });
  const verifierInput = JSON.parse(
    JSON.parse(calls[3]?.messages ?? "[]")[1].content
  );
  expect(verifierInput.evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "e2",
        value: {
          goals: [{ id: "goal-1", content: "human approval unresolved" }],
        },
      }),
    ])
  );
  expect(executions.filter((name) => name === GOAL_LIST_NAME)).toHaveLength(2);
});
it("bounds the final typed envelope including receipts", async () => {
  const { result } = await exercise({
    program: { ...program, limits: { resultBytes: 1800 } },
    source: {
      mode: "get",
      totalFound: 1,
      entries: [
        {
          id: "review-skill",
          content: body,
          sourceRef: "r".repeat(1000),
          entryType: "skill",
          tags: ["expertise-role"],
        },
      ],
    },
  });
  expect(result.structuredOutput).toMatchObject({
    status: "incomplete",
    reason: "result_byte_limit",
  });
  expect(Buffer.byteLength(result.content ?? "")).toBeLessThanOrEqual(1800);
});
it("bounds cumulative input and tool bytes before downstream roles", async () => {
  const input = await exercise({
    program: { ...program, limits: { inputBytes: 100 } },
  });
  expect(input.result.structuredOutput?.reason).toBe("input_byte_limit");
  expect(input.calls).toHaveLength(0);
  const tools = await exercise({
    program: { ...program, limits: { toolBytes: 100 } },
  });
  expect(tools.result.structuredOutput?.reason).toBe("tool_byte_limit");
  expect(tools.calls).toHaveLength(0);
});
