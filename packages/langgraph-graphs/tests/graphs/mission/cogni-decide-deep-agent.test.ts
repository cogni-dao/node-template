// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import {
  edoDecideContract,
  goalListContract,
  knowledgeReadContract,
  workItemReadContract,
  workItemTransitionContract,
} from "@cogni/ai-tools";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LANGGRAPH_CATALOG } from "../../../src/catalog";
import { COGNI_DECIDE_TOOL_IDS } from "../../../src/graphs/mission/cogni-decide";
import { createMissionGraph } from "../../../src/graphs/mission/graph";
import { RunReceipts } from "../../../src/graphs/work-prioritizer/receipts";
import { createScoresGuard } from "../../../src/graphs/work-prioritizer/score-guard";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn, ToolExecFn } from "../../../src/inproc/types";

const origin = "https://node.example";
const guidance = ["mission", "goals"];
const source = `${origin}/knowledge/evidence`;
const item = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "task",
  status: "needs_implement",
  revision: 7,
  createdAt: new Date().toISOString(),
  labels: ["goal:delivery"],
  summary: `Evidence ${source}`,
  scores: {
    goal: { v: 1 },
    agent: { v: 3 },
    ease: { v: 3 },
    confidence: { v: 3 },
  },
  ...overrides,
});
function setup() {
  const receipts = new RunReceipts(origin);
  receipts.observe(
    "core__goal_list",
    {},
    {
      goals: [
        {
          id: "goal-delivery",
          content: `Deliver ${source}`,
          sourceUrl: source,
        },
      ],
    },
  );
  for (const id of guidance)
    receipts.observe(
      "core__knowledge_read",
      { id },
      { mode: "get", entries: [{ id, content: "read guidance" }] },
    );
  const writes: Record<string, unknown>[] = [];
  const writer = new DynamicStructuredTool({
    name: "core__work_item_transition",
    description: "Host writer",
    schema: z.object({}).passthrough(),
    func: async (value) => {
      writes.push(value);
      return JSON.stringify({ success: true });
    },
  });
  const guard = createScoresGuard(receipts, writer, guidance);
  const observe = (value: ReturnType<typeof item>) =>
    receipts.observe("core__work_item_read", { id: value.id }, { item: value });
  const propose = (
    id: string,
    scores: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => guard.invoke({ id, expectedRevision: 7, scores, ...extra });
  return { receipts, writes, guard, observe, propose };
}

describe("scheduled scores-only decision guard", () => {
  it("catalog exposes the narrow writer and no EDO", () => {
    const entry = LANGGRAPH_CATALOG["cogni-decide"];
    expect(entry?.toolIds).toEqual(COGNI_DECIDE_TOOL_IDS);
    expect(entry?.toolIds).not.toContain("core__edo_decide");
  });
  it("requires current-run complete item, goal citation and guidance before any write", async () => {
    const a = setup();
    expect(await a.propose("task.1", { goal: { v: 3 } })).toContain(
      "guard_rejected",
    );
    a.observe(item("task.1", { labels: [] }));
    expect(await a.propose("task.1", { goal: { v: 3 } })).toContain(
      "goal_citation",
    );
    a.observe(item("task.1"));
    a.receipts.guidance.delete("mission");
    expect(await a.propose("task.1", { goal: { v: 3 } })).toContain(
      "guard_rejected",
    );
    expect(a.writes).toHaveLength(0);
  });
  it("no-ops with no goals or unchanged values and rejects unread, closed and stale revisions", async () => {
    const a = setup();
    a.observe(item("task.1"));
    a.receipts.goals.clear();
    expect(await a.propose("task.1", { goal: { v: 3 } })).toContain(
      "goal_citation",
    );
    expect(a.writes).toHaveLength(0);
    const b = setup();
    b.observe(item("task.1"));
    expect(await b.propose("task.1", { goal: { v: 1 } })).toBe("no_change");
    expect(
      await b.guard.invoke({
        id: "task.1",
        expectedRevision: 8,
        scores: { goal: { v: 3 } },
      }),
    ).toContain("guard_rejected");
    b.observe(item("task.2", { status: "done" }));
    expect(await b.propose("task.2", { goal: { v: 3 } })).toContain(
      "guard_rejected",
    );
    expect(b.writes).toHaveLength(0);
  });
  it("writes only a CAS scores patch with observed linked evidence", async () => {
    const a = setup();
    a.observe(item("task.1"));
    expect(await a.propose("task.1", { goal: { v: 4, ev: source } })).toContain(
      '"success":true',
    );
    expect(a.writes).toHaveLength(1);
    expect(Object.keys(a.writes[0] ?? {}).sort()).toEqual([
      "action",
      "expectedRevision",
      "id",
      "scores",
    ]);
    expect(a.writes[0]).toMatchObject({
      action: "patch",
      id: "task.1",
      expectedRevision: 7,
      scores: { goal: { v: 4, ev: source } },
    });
    const b = setup();
    b.observe(item("task.1"));
    expect(
      await b.propose("task.1", {
        goal: { v: 4, ev: "https://unknown.example/evidence" },
      }),
    ).toContain("guard_rejected");
    expect(b.writes).toHaveLength(0);
  });
  it("limits each tick to five writes", async () => {
    const a = setup();
    for (let n = 0; n < 8; n++) {
      const id = `task.${n}`;
      a.observe(item(id));
      await a.propose(id, { goal: { v: 3 } });
    }
    expect(a.writes).toHaveLength(5);
  });
  it("converges across ticks: one score update then one-point jitter is a no-op", async () => {
    const a = setup();
    a.observe(item("task.1"));
    await a.propose("task.1", { goal: { v: 3 } });
    expect(a.writes).toHaveLength(1);
    const b = setup();
    b.observe(item("task.1", { revision: 8, scores: { goal: { v: 3 } } }));
    expect(
      await b.guard.invoke({
        id: "task.1",
        expectedRevision: 8,
        scores: { goal: { v: 2 } },
      }),
    ).toBe("no_change");
    expect(b.writes).toHaveLength(0);
  });
  it("clamps stalled confidence and blocked agent; delivering ease settles at five", async () => {
    const a = setup();
    a.observe(
      item("task.1", {
        createdAt: new Date(Date.now() - 15 * 86_400_000).toISOString(),
      }),
    );
    await a.propose("task.1", { confidence: { v: 3 } });
    expect(a.writes[0]).toMatchObject({ scores: { confidence: { v: 2 } } });
    const b = setup();
    b.observe(item("task.2", { status: "blocked" }));
    await b.propose("task.2", { agent: { v: 3 } });
    expect(b.writes[0]).toMatchObject({ scores: { agent: { v: 1 } } });
    const c = setup();
    c.observe(
      item("task.3", { status: "needs_merge", scores: { ease: { v: 3 } } }),
    );
    await c.propose("task.3", { ease: { v: 3, ev: source } });
    expect(c.writes[0]).toMatchObject({ scores: { ease: { v: 5 } } });
    const d = setup();
    d.observe(
      item("task.3", {
        status: "needs_merge",
        scores: { ease: { v: 5, ev: source } },
      }),
    );
    expect(await d.propose("task.3", { ease: { v: 5, ev: source } })).toBe(
      "no_change",
    );
    expect(d.writes).toHaveLength(0);
  });
  it("does not apply a decision-confidence floor to a score patch", async () => {
    const a = setup();
    a.observe(item("task.1"));
    await a.propose("task.1", { goal: { v: 3 } }, { confidence: 0.1 });
    expect(a.writes).toHaveLength(1);
    expect(a.writes[0]).toMatchObject({ scores: { goal: { v: 3 } } });
  });
});

describe("scheduled DECIDE through the shared public runner", () => {
  it("plans, delegates current reads through Flash, scores once and revises the plan without EDO", async () => {
    const tool = (id: string, name: string, args: object) => ({
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    });
    const required = [
      "dao-goals-design",
      "program-behavior-mode",
      "work-item-scores-design",
      "mission-loop-expert",
    ];
    const calls = [
      {
        toolCalls: [
          tool("plan", "write_todos", {
            todos: [{ content: "Read evidence", status: "in_progress" }],
          }),
        ],
      },
      {
        toolCalls: [
          tool("delegate", "task", {
            subagent_type: "ledger-reader",
            description: "Read the goal, task and required guidance.",
          }),
        ],
      },
      {
        toolCalls: [
          tool("goals", "core__goal_list", {}),
          tool("item", "core__work_item_read", { id: "task.1" }),
          ...required.map((id, i) =>
            tool(`guide-${i}`, "core__knowledge_read", { id }),
          ),
        ],
      },
      { content: "Read goal-delivery and task.1 revision 7." },
      {
        toolCalls: [
          tool("score", "work_item_scores_write", {
            id: "task.1",
            expectedRevision: 7,
            scores: { goal: { v: 3 } },
          }),
        ],
      },
      {
        toolCalls: [
          tool("revise", "write_todos", {
            todos: [
              { content: "Read evidence", status: "completed" },
              { content: "Report", status: "in_progress" },
            ],
          }),
        ],
      },
      { content: "Updated task.1 for goal-delivery." },
    ];
    let turn = 0;
    const models: string[] = [];
    const offered: string[] = [];
    const completionFn: CompletionFn = (request) => {
      models.push(request.model);
      offered.push(
        ...(request.tools ?? []).map(
          (t) => (t as { function: { name: string } }).function.name,
        ),
      );
      return {
        stream: (async function* () {})(),
        final: Promise.resolve({
          ok: true as const,
          ...(calls[turn++] ?? { content: "Done." }),
        }),
      };
    };
    const executed: Array<{ name: string; args: unknown }> = [];
    const execute: ToolExecFn = async (name, args) => {
      executed.push({ name, args });
      if (name === "core__goal_list")
        return {
          ok: true,
          value: {
            goals: [
              {
                id: "goal-delivery",
                title: "Delivery",
                evaluateAt: null,
                content: "Improve delivery.",
              },
            ],
          },
        };
      if (name === "core__work_item_read")
        return { ok: true, value: { item: item("task.1") } };
      if (name === "core__knowledge_read")
        return {
          ok: true,
          value: {
            mode: "get",
            entries: [
              { id: (args as { id: string }).id, content: "Read guidance" },
            ],
            totalFound: 1,
          },
        };
      if (name === "core__work_item_transition")
        return {
          ok: true,
          value: { success: true, action: "patch", id: "task.1", revision: 8 },
        };
      return {
        ok: false,
        errorCode: "execution",
        safeMessage: "unexpected tool",
      };
    };
    const run = createInProcGraphRunner({
      program: "cogni-decide",
      requestIntent: "decide",
      sourceContext: {
        nodeId: "test-node",
        origin,
        mission: {
          content: "Test mission",
          sourceRef: "test:mission",
          buildSha: null,
        },
      },
      createGraph: createMissionGraph,
      completionFn,
      createToolExecFn: () => execute,
      toolContracts: [
        goalListContract,
        workItemReadContract,
        knowledgeReadContract,
        workItemTransitionContract,
        edoDecideContract,
      ],
      request: {
        runId: "decision-sdk-control",
        messages: [{ role: "user", content: "Review the ledger." }],
        configurable: {
          model: "parent-model",
          toolIds: [...COGNI_DECIDE_TOOL_IDS],
        },
      },
    });
    for await (const _ of run.stream) {
      /* drain */
    }
    const result = await run.final;
    expect(result.ok).toBe(true);
    expect(models).toContain("deepseek-v4-flash");
    expect(offered).toEqual(
      expect.arrayContaining(["write_todos", "task", "work_item_scores_write"]),
    );
    expect(offered).not.toContain("core__edo_decide");
    expect(offered).not.toContain("core__work_item_transition");
    expect(
      executed.filter((x) => x.name === "core__knowledge_read"),
    ).toHaveLength(4);
    expect(executed).toEqual(
      expect.arrayContaining([
        { name: "core__goal_list", args: {} },
        { name: "core__work_item_read", args: { id: "task.1" } },
      ]),
    );
    const writes = executed.filter(
      (x) => x.name === "core__work_item_transition",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toMatchObject({
      action: "patch",
      id: "task.1",
      expectedRevision: 7,
      scores: { goal: { v: 3 } },
    });
    expect(Object.keys(writes[0]?.args as object).sort()).toEqual([
      "action",
      "expectedRevision",
      "id",
      "scores",
    ]);
    expect(executed.some((x) => x.name === "core__edo_decide")).toBe(false);
  });
});
