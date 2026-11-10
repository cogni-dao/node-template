// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Step budget (task.0065, langgraph-error-handling): a run that hits the recursion limit ends with the
 * program's own report, not an error. Deterministic: the fake graph writes once, then exhausts its steps.
 */
import type { AiEvent } from "@cogni/ai-core";
import { workItemUpdateContract } from "@cogni/ai-tools";
import { GraphRecursionError } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { createPrioritizerRunHooks } from "../../src/graphs/work-prioritizer/graph";
import type { CreateReactAgentGraphOptions } from "../../src/graphs/types";
import { createInProcGraphRunner } from "../../src/inproc/runner";
import type {
  CompletionFn,
  CreateGraphFn,
  ToolExecFn,
} from "../../src/inproc/types";

const completionFn: CompletionFn = () => ({
  stream: (async function* (): AsyncIterable<AiEvent> {})(),
  final: Promise.resolve({
    ok: true as const,
    content: "",
    finishReason: "stop",
  }),
});

function run(createGraph: CreateGraphFn) {
  const events: AiEvent[] = [];
  const { stream, final } = createInProcGraphRunner({
    program: "work-review",
    createGraph,
    completionFn,
    createToolExecFn: (): ToolExecFn => async () => ({
      ok: true,
      value: { success: true, id: "task.1", message: "ok", revision: 8 },
    }),
    toolContracts: [workItemUpdateContract],
    request: {
      runId: "budget",
      messages: [{ role: "user", content: "triage" }],
      configurable: {
        model: "test-model",
        toolIds: [workItemUpdateContract.name],
      },
    },
  });
  return (async () => {
    for await (const event of stream) events.push(event);
    return { events, result: await final };
  })();
}

/** A graph that writes through the host tool, then runs out of steps. */
function exhaustedGraph(write: boolean): CreateGraphFn {
  const factory = (opts: CreateReactAgentGraphOptions) => ({
    invoke: async () => {
      if (write)
        await opts.tools[0]?.invoke(
          { id: "task.1", expectedRevision: 7, set: { status: "needs_design" } },
          { configurable: { toolIds: [workItemUpdateContract.name] } },
        );
      throw new GraphRecursionError("Recursion limit of 100 reached");
    },
  });
  return Object.assign(factory, {
    createRunHooks: createPrioritizerRunHooks,
  }) as unknown as CreateGraphFn;
}

describe("step budget ends in a report", () => {
  it("returns ok with the program report and keeps the writes already made", async () => {
    const { events, result } = await run(exhaustedGraph(true));
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/^STEP_BUDGET: .*Changed 1 item\(s\): task\.1/);
    expect(result.structuredOutput).toMatchObject({
      telemetry: {
        aborted: true,
        abortReason: "step_budget",
        changedItemIds: ["task.1"],
        changeCount: 1,
      },
    });
    expect(events.filter((e) => e.type === "assistant_final")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("reports zero changes when the budget ends a read-only run", async () => {
    const { result } = await run(exhaustedGraph(false));
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Changed 0 item(s)");
  });

  it("keeps the error for a graph with no report hook", async () => {
    const plain = (() => ({
      invoke: async () => {
        throw new GraphRecursionError("Recursion limit of 100 reached");
      },
    })) as unknown as CreateGraphFn;
    const { result } = await run(plain);
    expect(result.ok).toBe(false);
  });
});
