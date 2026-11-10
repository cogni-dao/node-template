// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The prioritizer binds core__work_item_transition by its real contract behind a thin guard (task.0065).
 * Deterministic: a fake host writer records what reaches the ToolRunner; no model runs.
 */
import {
  WORK_ITEM_TRANSITION_NAME,
  WorkItemTransitionInputSchema,
} from "@cogni/ai-tools";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPrioritizerRunHooks } from "../../../src/graphs/work-prioritizer/graph";
import { TRIAGE_GUIDANCE_ID } from "../../../src/graphs/work-prioritizer/prompts";
import type { RunReceipts } from "../../../src/graphs/work-prioritizer/receipts";
import { createTransitionGuard } from "../../../src/graphs/work-prioritizer/transition-guard";

const origin = "https://node.example";
const source = `${origin}/knowledge/work-item-scores-design`;
const item = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "task",
  status: "needs_triage",
  revision: 7,
  createdAt: new Date().toISOString(),
  labels: [],
  summary: `Fix the thing. Evidence ${source}`,
  scores: {},
  ...overrides,
});

function setup(opts: { guidance?: boolean; goals?: boolean } = {}) {
  const hooks = createPrioritizerRunHooks({ program: "work-review", origin });
  const receipts = hooks.graphOptions.programState as RunReceipts;
  if (opts.goals !== false)
    hooks.observeTool("core__goal_list", {}, {
      ok: true,
      value: {
        goals: [
          { id: "goal-delivery", content: "Deliver", sourceUrl: source },
        ],
      },
    });
  if (opts.guidance !== false)
    for (const id of [TRIAGE_GUIDANCE_ID, "work-item-scores-design"])
      hooks.observeTool("core__knowledge_read", { id }, {
        ok: true,
        value: { mode: "get", entries: [{ id, content: `guide ${id}` }] },
      });
  const writes: Record<string, unknown>[] = [];
  const writer = new DynamicStructuredTool({
    name: WORK_ITEM_TRANSITION_NAME,
    description: "Host writer",
    schema: z.object({}).passthrough(),
    func: async (value) => {
      writes.push(value);
      return JSON.stringify({
        success: true,
        revision:
          typeof value.expectedRevision === "number"
            ? value.expectedRevision + 1
            : undefined,
      });
    },
  });
  const guard = createTransitionGuard(receipts, writer, [TRIAGE_GUIDANCE_ID]);
  const read = (value: ReturnType<typeof item>) =>
    hooks.observeTool("core__work_item_read", { id: value.id }, {
      ok: true,
      value: { item: value },
    });
  const call = (input: Record<string, unknown>) => guard.invoke(input as never);
  return { hooks, receipts, writes, writer, guard, read, call };
}

const scores = (v: number, ev?: string) => ({
  goal: { v, ...(ev ? { ev } : {}) },
  time: { v: 2 },
  unblocks: { v: 2 },
  ease: { v: 3 },
  confidence: { v: 3 },
  agent: { v: 3 },
});

describe("work-prioritizer binds core__work_item_transition directly", () => {
  it("offers the real tool contract under the real name", () => {
    const a = setup();
    expect(a.guard.name).toBe(WORK_ITEM_TRANSITION_NAME);
    expect(a.guard.description).toBe(a.writer.description);
    expect(a.guard.schema).toBe(WorkItemTransitionInputSchema);
  });

  it("writes scores plus a goal link as one CAS patch, then keeps the new revision", async () => {
    const a = setup();
    a.read(item("task.1", { labels: ["area:ai"] }));
    const out = await a.call({
      action: "patch",
      id: "task.1",
      expectedRevision: 7,
      labels: ["area:ai", "goal:delivery"],
      scores: scores(3),
      reason: "scores and goal link",
    });
    expect(out).toContain('"success":true');
    expect(a.writes[0]).toMatchObject({
      action: "patch",
      id: "task.1",
      expectedRevision: 7,
      labels: ["area:ai", "goal:delivery"],
    });
    // The guard stored revision 8: a status route needs no re-read, a second patch uses 8.
    expect(
      await a.call({
        action: "patch",
        id: "task.1",
        expectedRevision: 7,
        scores: scores(2),
      }),
    ).toContain("expected_revision");
  });

  it("routes status and cancels with a reason; never done", async () => {
    const a = setup();
    a.read(item("task.1"));
    a.read(item("task.2"));
    a.read(item("task.3"));
    a.read(item("task.4"));
    expect(
      await a.call({ action: "transition", id: "task.1", toStatus: "needs_implement" }),
    ).toContain('"success":true');
    expect(
      await a.call({ action: "transition", id: "task.2", toStatus: "cancelled" }),
    ).toContain("cancel_needs_reason");
    expect(
      await a.call({
        action: "transition",
        id: "task.2",
        toStatus: "cancelled",
        reason: "Superseded by task.9",
      }),
    ).toContain('"success":true');
    expect(
      await a.call({ action: "transition", id: "task.3", toStatus: "done" }),
    ).toContain("route_not_allowed");
    expect(
      await a.call({ action: "transition", id: "task.4", toStatus: "needs_triage" }),
    ).toContain("route_not_allowed");
    expect(a.writes.map((w) => w.toStatus)).toEqual([
      "needs_implement",
      "cancelled",
    ]);
  });

  it("refuses priority, rank, summary and unsafe labels", async () => {
    const a = setup();
    a.read(item("task.1", { labels: ["area:ai"] }));
    const base = { action: "patch", id: "task.1", expectedRevision: 7 };
    // The tool schema itself forbids priority beside scores; the guard also refuses it alone.
    for (const extra of [{ priority: 3 }, { rank: 1 }, { summary: "New" }])
      expect(await a.call({ ...base, ...extra })).toContain(
        "field_not_allowed",
      );
    // Drops an existing label.
    expect(
      await a.call({ ...base, labels: ["goal:delivery"] }),
    ).toContain("guard_rejected: labels");
    // Adds a label that is not a listed goal.
    expect(
      await a.call({ ...base, labels: ["area:ai", "goal:made-up"] }),
    ).toContain("guard_rejected: labels");
    expect(a.writes).toHaveLength(0);
  });

  it("needs evidence read this run for a score of 4-5, never the item's own page", async () => {
    const a = setup();
    const own = `${origin}/work/items/task.1`;
    a.read(item("task.1", { sourceUrl: own }));
    const base = { action: "patch", id: "task.1", expectedRevision: 7 };
    for (const ev of [
      undefined,
      "https://unknown.example/page",
      own,
      `${origin}/work/items/task.1/`,
      `${origin}/api/v1/work/items/task.1`,
    ])
      expect(await a.call({ ...base, scores: scores(4, ev) })).toContain(
        "guard_rejected: evidence",
      );
    expect(a.writes).toHaveLength(0);
    expect(await a.call({ ...base, scores: scores(4, source) })).toContain(
      '"success":true',
    );
    expect(a.writes).toHaveLength(1);
  });

  it("changes at most five distinct items per run", async () => {
    const a = setup();
    for (let n = 1; n <= 7; n++) {
      a.read(item(`task.${n}`));
      await a.call({
        action: "transition",
        id: `task.${n}`,
        toStatus: "needs_design",
      });
    }
    expect(a.writes).toHaveLength(5);
  });

  it("requires the triage guide, goals and a fresh item read before any write", async () => {
    const noGuide = setup({ guidance: false });
    noGuide.read(item("task.1"));
    expect(
      await noGuide.call({ action: "transition", id: "task.1", toStatus: "needs_design" }),
    ).toContain("guard_rejected: guidance");
    const noGoals = setup({ goals: false });
    noGoals.read(item("task.1"));
    expect(
      await noGoals.call({ action: "transition", id: "task.1", toStatus: "needs_design" }),
    ).toContain("guard_rejected: goals");
    const a = setup();
    expect(
      await a.call({ action: "transition", id: "task.9", toStatus: "needs_design" }),
    ).toContain("item_not_read");
    a.read(item("task.2", { status: "done" }));
    expect(
      await a.call({ action: "transition", id: "task.2", toStatus: "needs_design" }),
    ).toContain("item_closed");
    expect(a.writes).toHaveLength(0);
  });

  it("writes nothing when the item already matches (a repeat run is quiet)", async () => {
    const a = setup();
    a.read(
      item("task.1", {
        status: "needs_implement",
        labels: ["goal:delivery"],
        scores: scores(3),
      }),
    );
    expect(
      await a.call({
        action: "patch",
        id: "task.1",
        expectedRevision: 7,
        labels: ["goal:delivery"],
        scores: scores(3),
      }),
    ).toBe("no_change");
    expect(
      await a.call({ action: "transition", id: "task.1", toStatus: "needs_implement" }),
    ).toBe("no_change");
    expect(a.writes).toHaveLength(0);
  });
});

describe("no read-failure latch", () => {
  it("a failed read of an unrelated item does not block a write", async () => {
    const a = setup();
    a.hooks.observeTool("core__work_item_read", { id: "task.404" }, {
      ok: false,
      errorCode: "not_found",
    });
    a.hooks.observeTool("core__knowledge_read", { id: "agent-human-boundary" }, {
      ok: false,
      errorCode: "not_found",
    });
    a.hooks.observeTool("core__work_item_read", { id: "task.5" }, {
      ok: true,
      value: { item: null },
    });
    a.read(item("task.1"));
    expect(
      await a.call({ action: "transition", id: "task.1", toStatus: "needs_design" }),
    ).toContain('"success":true');
    // The unread item stays unwritable; only that item is affected.
    expect(
      await a.call({ action: "transition", id: "task.404", toStatus: "needs_design" }),
    ).toContain("item_not_read");
    expect(a.writes).toHaveLength(1);
  });
});
