// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/inproc/step-budget-per-program`
 * Purpose: bug.0080. One runner step limit (a backstop), and the step-limit answer comes from the run that happened: chat reports its sandbox work and the next step, only a scheduled tick uses schedule wording.
 * Scope: Deterministic fake graphs through the real runner, the real coordinator hooks and the real provider.
 * Invariants: ONE_STEP_LIMIT, ANSWER_FROM_THE_RUN_THAT_RAN
 * Side-effects: none
 * Links: https://node-template.cognidao.org/work/items/bug.0080
 */

import type { AiEvent } from "@cogni/ai-core";
import { SANDBOX_SHELL_NAME, sandboxShellContract } from "@cogni/ai-tools";
import { GraphRecursionError } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { LANGGRAPH_CATALOG } from "../../src/catalog";
import { createCoordinatorRunHooks } from "../../src/graphs/coordinator/graph";
import type { CreateReactAgentGraphOptions } from "../../src/graphs/types";
import { RUN_STEP_LIMIT, createInProcGraphRunner } from "../../src/inproc/runner";
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

describe("one runner step limit, a backstop", () => {
  it("invokes every graph with RUN_STEP_LIMIT (1000), and no catalog entry declares its own", async () => {
    expect(RUN_STEP_LIMIT).toBe(1000);
    expect((await run({})).seenLimit.value).toBe(RUN_STEP_LIMIT);
    expect(Object.values(LANGGRAPH_CATALOG).some((entry) => "stepBudget" in entry)).toBe(false);
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

  it("a committed but unpushed run says the commit is lost and never promises to continue it", async () => {
    const { result } = await run({ interactive: true, calls: [clone, branch, commit] });
    expect(result.content).toContain("I ran 3 sandbox commands.");
    expect(result.content).toContain("Branch: docs/readme.");
    expect(result.content).toContain("Commit: yes.");
    expect(result.content).toContain("Pushed: no.");
    expect(result.content).toContain("Pull request: none.");
    expect(result.content).toContain("A follow-up run starts in a fresh sandbox.");
    expect(result.content).toContain("never pushed, so it is lost");
    expect(result.content).toContain("starts over from the last pushed state");
    expect(result.content).not.toMatch(/Ask me to continue|push the branch and open/);
  });

  it("a pushed branch carries over and the next step is the pull request", async () => {
    const { result } = await run({ interactive: true, calls: [clone, branch, commit, push] });
    expect(result.content).toContain("Pushed: yes.");
    expect(result.content).toContain("The pushed branch keeps that work. Next: open the pull request.");
  });

  it("chat reports the pull request when one was opened", async () => {
    const { result } = await run({ interactive: true, calls: [clone, branch, commit, push, pr] });
    expect(result.content).toContain("Pull request: https://github.com/acme/site/pull/7.");
    expect(result.content).toContain("The pull request is open");
  });

  it.each([
    ["a piped push", "git push origin docs/readme 2>&1 | tail -1"],
    ["a push followed by another step", "git push origin docs/readme; echo done"],
    ["a push with a fallback", "git push origin docs/readme || true"],
    ["a multi-line script", "git status\ngit push origin docs/readme"],
  ])("%s exits 0 but does not prove the push: Pushed is unknown, never yes", async (_name, command) => {
    const { result } = await run({ interactive: true, calls: [{ command, exitCode: 0, output: "" }] });
    expect(result.content).toContain("Pushed: unknown.");
    expect(result.content).not.toContain("Pushed: yes.");
    expect(result.content).toContain("check the remote branch");
  });

  it("an && chain proves the push, and a dry run proves nothing", async () => {
    const chained = await run({
      interactive: true,
      calls: [{ command: "git add -A && git commit -m x && git push origin b", exitCode: 0, output: "" }],
    });
    expect(chained.result.content).toContain("Commit: yes.");
    expect(chained.result.content).toContain("Pushed: yes.");
    const merged = await run({
      interactive: true,
      calls: [{ command: "git push origin b 2>&1", exitCode: 0, output: "" }],
    });
    expect(merged.result.content).toContain("Pushed: yes.");
    const dry = await run({
      interactive: true,
      calls: [{ command: "git push --dry-run origin b", exitCode: 0, output: "" }],
    });
    expect(dry.result.content).toContain("Pushed: no.");
  });

  it("a failed command is never counted as a commit", async () => {
    const { result } = await run({ interactive: true, calls: [{ ...commit, exitCode: 1 }] });
    expect(result.content).toContain("Commit: none.");
    expect(result.content).toContain("Nothing was committed");
  });

  it("a scheduled tick keeps the schedule wording", async () => {
    const { result } = await run({ interactive: false });
    expect(result.content).toBe(
      "STEP_BUDGET: the coordinating tick reached its step limit. Schedule changes: none.",
    );
    expect(result.structuredOutput).toMatchObject({ telemetry: { abortReason: "step_budget" } });
  });
});
