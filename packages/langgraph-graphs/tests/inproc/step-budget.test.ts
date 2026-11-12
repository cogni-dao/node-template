// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Step budget (task.0065, langgraph-error-handling): a run that hits the recursion limit ends with the
 * program's own report, not an error. Deterministic: the fake graph writes once, then exhausts its steps.
 */
import type { AiEvent } from "@cogni/ai-core";
import {
  CORE_TOOL_BUNDLE,
  workItemReadContract,
  workItemUpdateContract,
} from "@cogni/ai-tools";
import { AIMessage } from "@langchain/core/messages";
import { GraphRecursionError } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import type { CreateReactAgentGraphOptions } from "../../src/graphs/types";
import {
  createPrioritizerRunHooks,
  createWorkPrioritizerGraph,
} from "../../src/graphs/work-prioritizer/graph";
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
      value: { id: "task.1", status: "needs_design", revision: 8 },
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
          {
            id: "task.1",
            expectedRevision: 7,
            reason: "test change",
            set: { status: "needs_design" },
          },
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
    expect(result.content).toMatch(
      /^STEP_BUDGET: .*Changed 1 item\(s\): task\.1/,
    );
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

describe("program completion verification", () => {
  it.each([true, false])(
    "runs fixed authorized reads before the first model call only with source identity (valid=%s)",
    async (valid) => {
      const names = [
        "core__knowledge_read",
        "core__goal_list",
        "core__goal_progress",
        "core__work_item_query",
      ];
      const contracts = CORE_TOOL_BUNDLE.filter((tool) =>
        names.includes(tool.contract.name),
      ).map((tool) => tool.contract);
      const reads: string[] = [];
      const candidateQueries: unknown[] = [];
      let modelCalls = 0;
      const model: CompletionFn = (params) => {
        modelCalls++;
        expect(reads).toHaveLength(9);
        expect(reads).toContain("core__knowledge_read:metrics-expert");
        expect(
          params.messages.filter((message) => message.role === "tool"),
        ).toHaveLength(9);
        expect(candidateQueries).toHaveLength(2);
        expect(candidateQueries[0]).toEqual({
          statuses: ["needs_triage"],
          limit: 50,
          sortBy: "createdAt",
          sortDirection: "desc",
        });
        expect(candidateQueries[1]).toMatchObject({
          scored: false,
          limit: 50,
          sortBy: "createdAt",
          sortDirection: "desc",
        });
        expect(
          (candidateQueries[1] as { statuses: string[] }).statuses,
        ).toEqual([
          "needs_triage",
          "needs_research",
          "needs_design",
          "needs_implement",
          "needs_closeout",
          "needs_merge",
          "blocked",
        ]);
        return {
          stream: (async function* (): AsyncIterable<AiEvent> {})(),
          final: Promise.resolve({
            ok: true,
            content: "No work performed.",
            finishReason: "stop",
          }),
        };
      };
      const { stream, final } = createInProcGraphRunner({
        program: "work-review",
        createGraph: createWorkPrioritizerGraph,
        completionFn: model,
        sourceContext: valid
          ? {
              nodeId: "local",
              origin: "https://node.example",
              mission: {
                content: "Local mission",
                sourceRef: "fixture",
                buildSha: null,
              },
            }
          : undefined,
        createToolExecFn: () => async (name, args) => {
          reads.push(
            name === "core__knowledge_read"
              ? `${name}:${(args as { id: string }).id}`
              : name,
          );
          if (name === "core__knowledge_read")
            return {
              ok: true,
              value: {
                mode: "get",
                entries: [
                  {
                    id: (args as { id: string }).id,
                    content: "Current full guidance.",
                  },
                ],
              },
            };
          if (name === "core__goal_list")
            return { ok: true, value: { goals: [] } };
          if (name === "core__work_item_query") {
            candidateQueries.push(args);
            return { ok: true, value: { items: [], count: 0 } };
          }
          return {
            ok: true,
            value: {
              goals: [],
              asOf: "2026-11-12T00:00:00.000Z",
              environment: "local",
              unbound: [],
              orphans: [],
            },
          };
        },
        toolContracts: contracts,
        request: {
          runId: "native-preflight",
          messages: [{ role: "user", content: "triage" }],
          configurable: { model: "test-model", toolIds: names },
        },
      });
      for await (const _event of stream) {
        /* Drain native graph events. */
      }
      expect((await final).ok).toBe(valid);
      expect(reads).toHaveLength(valid ? 9 : 0);
      expect(modelCalls).toBe(valid ? 1 : 0);
    },
  );
  it.each([false, true])(
    "respects cancellation before/during verification (during=%s)",
    async (during) => {
      const controller = new AbortController();
      let reads = 0;
      const factory = Object.assign(
        () => ({
          invoke: async () => {
            if (!during) controller.abort();
            return { messages: [new AIMessage("done")] };
          },
        }),
        {
          createRunHooks: () => ({
            verifyEffects: async (read: ToolExecFn) => {
              await read(workItemReadContract.name, { id: "task.1" });
              await read(workItemReadContract.name, { id: "task.2" });
            },
          }),
        },
      ) as unknown as CreateGraphFn;
      const { stream, final } = createInProcGraphRunner({
        createGraph: factory,
        completionFn,
        createToolExecFn: () => async () => {
          reads++;
          controller.abort();
          return new Promise(() => {});
        },
        toolContracts: [workItemReadContract],
        request: {
          runId: "cancelled-verification",
          messages: [],
          abortSignal: controller.signal,
          configurable: {
            model: "test-model",
            toolIds: [workItemReadContract.name],
          },
        },
      });
      const events: AiEvent[] = [];
      for await (const event of stream) events.push(event);
      expect(await final).toMatchObject({ ok: false, error: "aborted" });
      expect(reads).toBe(during ? 1 : 0);
      expect(events.some((event) => event.type === "assistant_final")).toBe(
        false,
      );
    },
  );
  it("performs readback before projecting and emitting the authoritative answer", async () => {
    const calls: string[] = [];
    const value = {
      id: "task.1",
      type: "task",
      status: "needs_design",
      revision: 8,
      labels: [],
      scores: {},
    };
    const factory = Object.assign(
      (opts: CreateReactAgentGraphOptions) => ({
        invoke: async () => {
          await opts.tools
            .find((tool) => tool.name === workItemUpdateContract.name)
            ?.invoke(
              {
                id: value.id,
                expectedRevision: 7,
                reason: "test change",
                set: { status: value.status },
              },
              { configurable: { toolIds: [workItemUpdateContract.name] } },
            );
          return {
            messages: [
              new AIMessage("Everything is verified and no work remains."),
            ],
          };
        },
      }),
      { createRunHooks: createPrioritizerRunHooks },
    ) as unknown as CreateGraphFn;
    const { stream, final } = createInProcGraphRunner({
      program: "work-review",
      createGraph: factory,
      completionFn,
      createToolExecFn: () => async (name) => {
        calls.push(name);
        return {
          ok: true,
          value: name === workItemReadContract.name ? { item: value } : value,
        };
      },
      toolContracts: [workItemUpdateContract, workItemReadContract],
      request: {
        runId: "verified",
        messages: [{ role: "user", content: "triage" }],
        configurable: {
          model: "test-model",
          toolIds: [workItemUpdateContract.name, workItemReadContract.name],
        },
      },
    });
    const events: AiEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await final;
    expect(calls).toEqual([
      workItemUpdateContract.name,
      workItemReadContract.name,
    ]);
    expect(result.content).toContain("Verified by post-write reads: task.1");
    expect(result.content).toContain("UNRESOLVED task.1");
    expect(result.content).not.toContain("Everything is verified");
    expect(events.filter((event) => event.type === "assistant_final")).toEqual([
      { type: "assistant_final", content: result.content },
    ]);
  });
  it("cannot use the verification hook to invoke a write", async () => {
    let invoked = false;
    const factory = Object.assign(
      () => ({ invoke: async () => ({ messages: [new AIMessage("done")] }) }),
      {
        createRunHooks: () => ({
          verifyEffects: async (read: ToolExecFn) => {
            await read(workItemUpdateContract.name, {});
          },
        }),
      },
    ) as unknown as CreateGraphFn;
    const { stream, final } = createInProcGraphRunner({
      createGraph: factory,
      completionFn,
      createToolExecFn: () => async () => {
        invoked = true;
        return { ok: true, value: {} };
      },
      toolContracts: [workItemUpdateContract],
      request: {
        runId: "read-only",
        messages: [],
        configurable: {
          model: "test-model",
          toolIds: [workItemUpdateContract.name],
        },
      },
    });
    for await (const _event of stream) {
      /* Drain the existing executor. */
    }
    expect((await final).ok).toBe(false);
    expect(invoked).toBe(false);
  });
});
