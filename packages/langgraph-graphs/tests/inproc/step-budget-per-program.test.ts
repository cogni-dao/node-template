// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/inproc/step-budget-per-program`
 * Purpose: bug.0080. The step budget is declared per catalog entry (with a hard ceiling), and the step-budget answer comes from the run that happened: chat reports its sandbox work and the next step, only a scheduled tick uses schedule wording.
 * Scope: Deterministic fake graphs through the real runner, the real coordinator hooks and the real provider.
 * Invariants: STEP_BUDGET_PER_ENTRY, CEILING_IS_HARD, ANSWER_FROM_THE_RUN_THAT_RAN
 * Side-effects: none
 * Links: https://node-template.cognidao.org/work/items/bug.0080
 */

import type { AiEvent } from "@cogni/ai-core";
import { SANDBOX_SHELL_NAME, sandboxShellContract } from "@cogni/ai-tools";
import { GraphRecursionError } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { COGNI_CHAT_STEP_BUDGET, LANGGRAPH_CATALOG } from "../../src/catalog";
import { createCoordinatorRunHooks } from "../../src/graphs/coordinator/graph";
import type { CreateReactAgentGraphOptions } from "../../src/graphs/types";
import {
  DEFAULT_RECURSION_LIMIT,
  MAX_RECURSION_LIMIT,
  createInProcGraphRunner,
  resolveRecursionLimit,
} from "../../src/inproc/runner";
import type { CompletionFn, CreateGraphFn, ToolExecFn } from "../../src/inproc/types";

const completionFn: CompletionFn = () => ({
  stream: (async function* (): AsyncIterable<AiEvent> {})(),
  final: Promise.resolve({ ok: true as const, content: "", finishReason: "stop" }),
});

type ShellCall = { command: string; exitCode: number; output: string };

/** A graph that runs the given shell calls through the host tool, records its recursion limit, then runs out of steps. */
function exhausted(calls: ShellCall[], seenLimit: { value?: number }): CreateGraphFn {
  const factory = (opts: CreateReactAgentGraphOptions) => ({
    invoke: async (_input: unknown, config?: { recursionLimit?: number }) => {
      seenLimit.value = config?.recursionLimit;
      for (const call of calls)
        await opts.tools[0]?.invoke({ command: call.command }, { configurable: { toolIds: [SANDBOX_SHELL_NAME] } });
      throw new GraphRecursionError("Recursion limit reached");
    },
  });
  return Object.assign(factory, { createRunHooks: createCoordinatorRunHooks }) as unknown as CreateGraphFn;
}

async function run(opts: {
  calls?: ShellCall[];
  interactive?: boolean;
  recursionLimit?: number;
}) {
  const calls = opts.calls ?? [];
  const seenLimit: { value?: number } = {};
  const results = new Map(calls.map((c) => [c.command, c]));
  const { stream, final } = createInProcGraphRunner({
    program: "cogni",
    createGraph: exhausted(calls, seenLimit),
    completionFn,
    createToolExecFn: (): ToolExecFn => async (_name, args) => {
      const call = results.get((args as { command: string }).command) as ShellCall;
      return {
        ok: true,
        value: { status: "ok", exitCode: call.exitCode, output: call.output, truncated: false },
      };
    },
    toolContracts: [sandboxShellContract as never],
    ...(opts.interactive !== undefined && { interactive: opts.interactive }),
    ...(opts.recursionLimit !== undefined && { recursionLimit: opts.recursionLimit }),
    request: {
      runId: "budget",
      messages: [{ role: "user", content: "make a README PR" }],
      configurable: { model: "test-model", toolIds: [SANDBOX_SHELL_NAME] },
    },
  });
  for await (const _event of stream) {
    /* drain */
  }
  return { result: await final, seenLimit };
}

describe("the step budget is declared per catalog entry, under a hard ceiling", () => {
  it("resolves the default, the entry's budget and the ceiling", () => {
    expect(resolveRecursionLimit(undefined)).toBe(DEFAULT_RECURSION_LIMIT);
    expect(resolveRecursionLimit(Number.NaN)).toBe(DEFAULT_RECURSION_LIMIT);
    expect(resolveRecursionLimit(0)).toBe(DEFAULT_RECURSION_LIMIT);
    expect(resolveRecursionLimit(250)).toBe(250);
    expect(resolveRecursionLimit(10_000)).toBe(MAX_RECURSION_LIMIT);
  });

  it("only cogni declares a budget, above the default and within the ceiling", () => {
    expect(LANGGRAPH_CATALOG.cogni?.stepBudget).toBe(COGNI_CHAT_STEP_BUDGET);
    expect(COGNI_CHAT_STEP_BUDGET).toBeGreaterThan(DEFAULT_RECURSION_LIMIT);
    expect(COGNI_CHAT_STEP_BUDGET).toBeLessThanOrEqual(MAX_RECURSION_LIMIT);
    expect(LANGGRAPH_CATALOG["work-prioritizer"]?.stepBudget).toBeUndefined();
    expect(LANGGRAPH_CATALOG["work-closeout"]?.stepBudget).toBeUndefined();
  });

  it("the runner invokes the graph with the declared budget, the default, or the ceiling", async () => {
    expect((await run({})).seenLimit.value).toBe(DEFAULT_RECURSION_LIMIT);
    expect((await run({ recursionLimit: COGNI_CHAT_STEP_BUDGET })).seenLimit.value).toBe(COGNI_CHAT_STEP_BUDGET);
    expect((await run({ recursionLimit: 99_999 })).seenLimit.value).toBe(MAX_RECURSION_LIMIT);
  });
});

describe("the step-budget answer comes from the run that happened", () => {
  const clone: ShellCall = { command: "git clone https://x/y.git .", exitCode: 0, output: "ok" };
  const branch: ShellCall = { command: "git checkout -b docs/readme", exitCode: 0, output: "" };
  const commit: ShellCall = { command: "git add -A && git commit -m docs", exitCode: 0, output: "" };
  const push: ShellCall = { command: "git push origin docs/readme", exitCode: 0, output: "" };
  const pr: ShellCall = {
    command: "gh pr create --fill",
    exitCode: 0,
    output: "https://github.com/acme/site/pull/7\n",
  };

  it("chat with no sandbox work says so plainly and never uses the schedule wording", async () => {
    const { result } = await run({ interactive: true });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("I made no changes in the sandbox.");
    expect(result.content).toContain("Next:");
    expect(result.content).not.toMatch(/coordinating tick|Schedule changes/);
  });

  it("chat reports branch, commit, push and the next step from the shell receipts", async () => {
    const { result } = await run({ interactive: true, calls: [clone, branch, commit] });
    expect(result.content).toContain("I ran 3 sandbox commands.");
    expect(result.content).toContain("Branch: docs/readme.");
    expect(result.content).toContain("Commit: yes.");
    expect(result.content).toContain("Pushed: no.");
    expect(result.content).toContain("Pull request: none.");
    expect(result.content).toContain("Next: push the branch and open the pull request.");
  });

  it("chat reports the pull request when one was opened", async () => {
    const { result } = await run({ interactive: true, calls: [clone, branch, commit, push, pr] });
    expect(result.content).toContain("Pull request: https://github.com/acme/site/pull/7.");
    expect(result.content).toContain("The pull request is open");
  });

  it("a failed command is never counted as a commit", async () => {
    const { result } = await run({ interactive: true, calls: [{ ...commit, exitCode: 1 }] });
    expect(result.content).toContain("Commit: none.");
  });

  it("a scheduled tick keeps the schedule wording", async () => {
    const { result } = await run({ interactive: false });
    expect(result.content).toBe(
      "STEP_BUDGET: the coordinating tick reached its step limit. Schedule changes: none.",
    );
    expect(result.structuredOutput).toMatchObject({ telemetry: { abortReason: "step_budget" } });
  });
});
