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
import { describe, expect, it, vi } from "vitest";
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
  criteria:
    "Check the decision against primary evidence and the exact required principle: unresolved human gates require defer. Accept approve only when the evidence establishes the gate is resolved. A no-change claim requires actual read evidence, not an author assertion.",
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

function startExercise(
  options: {
    program?: EvidenceProgram;
    replies?: CompletionResult[];
    source?: unknown;
    missingHost?: boolean;
    toolIds?: string[];
    complete?: (messages: string, call: number) => CompletionResult;
    onCompletionStart?: () => void;
    usage?: boolean;
    beforeTool?: (name: string, index: number) => Promise<void>;
    completionGate?: Promise<void>;
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
    options.onCompletionStart?.();
    return {
      stream: (async function* () {
        await options.completionGate;
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
      final: Promise.resolve(response),
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
      await options.beforeTool?.(name, executions.length - 1);
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
  return { runner, calls, executions, events };
}

async function exercise(options: Parameters<typeof startExercise>[0] = {}) {
  const { runner, calls, executions, events } = startExercise(options);
  for await (const event of runner.stream) events.push(event);
  return { result: await runner.final, calls, executions, events };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it("passes the exact rejected artifact to a targeted revision with principle feedback", async () => {
    const rejected = JSON.parse(proposal("approve"));
    rejected.summary = "Preserve this supported assessment";
    const { result, calls } = await exercise({
      complete(messages, call) {
        if (call === 0) return text("A human gate exists.");
        if (call === 1) return text(JSON.stringify(rejected));
        if (call === 2)
          return text(
            messages.includes(body) &&
              messages.includes("human approval unresolved")
              ? revise
              : accept
          );
        if (call === 3) {
          const input = JSON.parse(JSON.parse(messages).at(-1).content);
          expect(input.rejectedProposal).toEqual(rejected);
          expect(input.feedback).toBe(JSON.parse(revise).reason);
          return text(
            JSON.stringify({
              ...input.rejectedProposal,
              payload: { ...input.rejectedProposal.payload, decision: "defer" },
            })
          );
        }
        return text(accept);
      },
    });
    expect(result.structuredOutput).toMatchObject({
      status: "accepted",
      revisions: 1,
      proposal: { summary: rejected.summary, payload: { decision: "defer" } },
    });
    expect(calls).toHaveLength(5);
    expect(calls[3]?.messages).toContain("forbids approving");
  });

  it("repairs the exact invalid artifact once and then verifies fresh primary evidence", async () => {
    const invalid = {
      ...JSON.parse(proposal()),
      payload: { decision: "invented", extra: "retain invalid fields" },
    };
    const raw = JSON.stringify(invalid, null, 2);
    const { result, calls, executions } = await exercise({
      complete(messages, index) {
        if (index === 0) return text("facts");
        if (index === 1) return text(raw);
        const input = JSON.parse(JSON.parse(messages).at(-1).content);
        if (index === 2) {
          expect(input.rejectedArtifact).toBe(raw);
          expect(input.rejectedProposal).toEqual(invalid);
          expect(input.feedback).toContain("payload");
          expect(input.feedback).toContain("decision");
          return text(proposal());
        }
        expect(input).not.toHaveProperty("findings");
        expect(input.evidence[0].value.goals[0].content).toBe(
          "human approval unresolved"
        );
        return text(accept);
      },
    });
    expect(result.structuredOutput).toMatchObject({
      status: "accepted",
      revisions: 1,
    });
    expect(calls).toHaveLength(4);
    expect(
      calls.slice(1).every((c) => c.tools === undefined || c.tools === "[]")
    ).toBe(true);
    expect(executions).toEqual([KNOWLEDGE_READ_NAME, GOAL_LIST_NAME]);
  });

  it.each([
    "invalid",
    "verifier",
  ])("never spends a second revision after schema repair: %s", async (failure) => {
    const invalid = proposal("invented");
    const { result, calls } = await exercise({
      replies: [
        text("facts"),
        text(invalid),
        text(failure === "invalid" ? invalid : proposal()),
        text(revise),
      ],
    });
    expect(result.structuredOutput).toMatchObject({
      status: "incomplete",
      revisions: 1,
      reason:
        failure === "invalid"
          ? "invalid_proposal_schema"
          : "verification_rejected",
    });
    expect(result.structuredOutput).not.toHaveProperty("proposal");
    expect(calls).toHaveLength(failure === "invalid" ? 3 : 4);
  });

  it("does not count a revision denied before invocation by the shared budget", async () => {
    const { result, calls } = await exercise({
      program: { ...program, limits: { modelCalls: 2 } },
      replies: [text("facts"), text(proposal("invented"))],
    });
    expect(result.structuredOutput).toMatchObject({
      reason: "model_call_limit",
      revisions: 0,
    });
    expect(calls).toHaveLength(2);
  });

  it("bounds validation feedback independently of the exact rejected artifact", async () => {
    const verbose = {
      ...program,
      payloadSchema: z.unknown().superRefine((_value, ctx) => {
        for (let i = 0; i < 30; i++)
          ctx.addIssue({
            code: "custom",
            path: ["field".repeat(100), i],
            message: "✓".repeat(1000),
          });
      }),
    };
    const { result, calls } = await exercise({
      program: verbose,
      complete(messages, index) {
        if (index === 0) return text("facts");
        if (index === 2) {
          const input = JSON.parse(JSON.parse(messages).at(-1).content);
          expect(Buffer.byteLength(input.feedback)).toBeLessThanOrEqual(2048);
          expect(JSON.parse(input.feedback).issues.length).toBeLessThanOrEqual(
            8
          );
          expect(input.rejectedArtifact).toBe(proposal());
        }
        return text(proposal());
      },
    });
    expect(result.structuredOutput?.reason).toBe("invalid_proposal_schema");
    expect(calls).toHaveLength(3);
  });

  it("deadline after malformed author output prevents a revision without counting one", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const { result, calls } = await exercise({
        program: { ...program, limits: { deadlineMs: 5 } },
        complete(_input, index) {
          if (index === 0) return text("facts");
          vi.setSystemTime(Date.now() + 5);
          return text(proposal("invented"));
        },
      });
      expect(result.structuredOutput).toMatchObject({
        reason: "deadline_or_cancelled",
        revisions: 0,
      });
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not repair unlisted evidence failures from a program", async () => {
    const { result, calls } = await exercise({
      program: {
        ...program,
        validate: () => "current_scores_incomplete_or_invalid",
      },
    });
    expect(result.structuredOutput).toMatchObject({
      reason: "current_scores_incomplete_or_invalid",
      revisions: 0,
    });
    expect(calls).toHaveLength(2);
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
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const started = deferred();
    const stalled = deferred();
    const running = exercise({
      program: { ...program, limits: { deadlineMs: 5 } },
      onCompletionStart: started.resolve,
      completionGate: stalled.promise,
    });
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(5);
      stalled.resolve();
      const { result, calls } = await running;
      expect(result.structuredOutput).toMatchObject({
        status: "incomplete",
        reason: "deadline_or_cancelled",
      });
      expect(calls).toHaveLength(1);
    } finally {
      stalled.resolve();
      vi.useRealTimers();
    }
  });

  it.each([
    "guidance",
    "initial",
    "child",
  ] as const)("settles an unresolved %s read at deadline and ignores its late result", async (stage) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const started = deferred();
    const stalled = deferred();
    const target = stage === "guidance" ? 0 : stage === "initial" ? 1 : 2;
    const { runner, calls, executions, events } = startExercise({
      program: { ...program, limits: { deadlineMs: 15 } },
      replies: [toolCall(GOAL_LIST_NAME)],
      beforeTool: async (_name, index) => {
        if (index === target) {
          started.resolve();
          await stalled.promise;
        }
      },
    });
    const draining = (async () => {
      for await (const event of runner.stream) events.push(event);
    })();
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(15);
      const result = await runner.final;
      expect(result.structuredOutput).toMatchObject({
        status: "incomplete",
        reason: "deadline_or_cancelled",
      });
      await draining;
      const terminal = JSON.stringify(events);
      stalled.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.stringify(events)).toBe(terminal);
      expect(calls).toHaveLength(stage === "child" ? 1 : 0);
      expect(executions).toHaveLength(target + 1);
      expect(result.structuredOutput?.evidence).toHaveLength(
        stage === "child" ? 1 : 0
      );
    } finally {
      stalled.resolve();
      vi.useRealTimers();
    }
  });

  it("drains a cancellation-ignoring model's late usage before terminal without continuation", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const started = deferred();
    const stalled = deferred();
    const { runner, calls, executions, events } = startExercise({
      program: { ...program, limits: { deadlineMs: 15 } },
      completionGate: stalled.promise,
      onCompletionStart: started.resolve,
      usage: true,
      replies: [toolCall(WORK_ITEM_TRANSITION_NAME)],
    });
    const draining = (async () => {
      for await (const event of runner.stream) events.push(event);
    })();
    try {
      let settled = false;
      void runner.final.then(() => {
        settled = true;
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(15);
      // Unlike read waits, model cancellation is cooperative: keep billing custody.
      expect(settled).toBe(false);
      stalled.resolve();
      await draining;
      const result = await runner.final;
      expect(result.structuredOutput).toMatchObject({
        status: "incomplete",
        reason: "deadline_or_cancelled",
      });
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
      expect(calls).toHaveLength(1);
      expect(executions).toEqual([KNOWLEDGE_READ_NAME, GOAL_LIST_NAME]);
      const types = events.map((event) => (event as { type: string }).type);
      expect(types).toEqual([
        "usage_report",
        "text_delta",
        "assistant_final",
        "done",
      ]);
    } finally {
      stalled.resolve();
      vi.useRealTimers();
    }
  });

  it("rejects invented evidence references before a verifier call", async () => {
    const { result, calls } = await exercise({
      replies: [
        text("facts"),
        text(proposal().replace("e1", "invented")),
        text(proposal().replace("e1", "invented")),
      ],
    });
    expect(result.structuredOutput?.reason).toBe(
      "unsupported_evidence_reference"
    );
    expect(calls).toHaveLength(3);
  });

  it("supports a materially different output schema without another factory", async () => {
    const second = {
      ...program,
      id: "knowledge-review",
      assignment:
        "Compare the supplied knowledge sources and propose any contradictions.",
      criteria:
        "Check each claimed contradiction against the actual source contents. Accept no_change only when actual reads support the absence of contradictions and the contradictions array is empty. Never infer unread contents from a title.",
      payloadSchema: z.object({ contradictions: z.array(z.string()) }).strict(),
      payloadDescription: "{contradictions:string[]}",
    };
    const content = JSON.stringify({
      kind: "no_change",
      summary: "No contradiction in supplied source",
      evidenceIds: ["e1"],
      payload: { contradictions: [] },
    });
    const { result, calls } = await exercise({
      program: second,
      replies: [text("compared exact sources"), text(content), text(accept)],
    });
    const [child, author, verifier] = calls.map(
      (call) => JSON.parse(call.messages) as { role: string; content: string }[]
    );
    for (const messages of [child, author, verifier]) {
      expect(messages?.[0]?.content).toContain(body);
      expect(messages?.[0]?.content).toContain("Read-only; never claim writes");
      expect(messages?.[0]?.content).not.toMatch(
        /six-axis|goalId|work.item|rankScore/
      );
      expect(JSON.parse(messages?.[1]?.content ?? "{}").evidence).toEqual([
        expect.objectContaining({
          id: "e1",
          value: {
            goals: [{ id: "goal-1", content: "human approval unresolved" }],
          },
        }),
      ]);
    }
    expect(child?.[0]?.content).not.toContain(second.assignment);
    expect(JSON.parse(child?.[1]?.content ?? "{}").programContext).toBe(
      second.assignment
    );
    expect(
      child
        ?.map((m) => m.content)
        .join("\n")
        .split(second.assignment)
    ).toHaveLength(2);
    expect(child?.[0]?.content).toContain("never author the final proposal");
    expect(author?.[0]?.content).toContain(second.assignment);
    expect(verifier?.[0]?.content).toContain(second.criteria);
    expect(verifier?.[0]?.content).not.toContain(second.assignment);
    expect(JSON.parse(verifier?.[1]?.content ?? "{}")).not.toHaveProperty(
      "findings"
    );
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
