// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The prioritizer binds core__work_item_update (the PATCH route's twin) behind a thin guard (task.0065).
 * Deterministic: a fake host writer records what reaches the ToolRunner; no model runs.
 */
import {
  WORK_ITEM_UPDATE_NAME,
  workItemUpdateContract,
} from "@cogni/ai-tools";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPrioritizerRunHooks } from "../../../src/graphs/work-prioritizer/graph";
import { TRIAGE_GUIDANCE_ID } from "../../../src/graphs/work-prioritizer/prompts";
import type { RunReceipts } from "../../../src/graphs/work-prioritizer/receipts";
import { createTriageGuard } from "../../../src/graphs/work-prioritizer/triage-guard";

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
    name: WORK_ITEM_UPDATE_NAME,
    description: "Host writer",
    schema: z.object({}).passthrough(),
    func: async (value) => {
      writes.push(value);
      const set = (value.set ?? {}) as Record<string, unknown>;
      return JSON.stringify({
        id: value.id,
        status: set.status ?? "needs_triage",
        labels: set.labels ?? [],
        scores: set.scores,
        revision:
          typeof value.expectedRevision === "number"
            ? value.expectedRevision + 1
            : undefined,
      });
    },
  });
  const guard = createTriageGuard(receipts, writer, [TRIAGE_GUIDANCE_ID]);
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
const update = (id: string, set: Record<string, unknown>, extra = {}) => ({
  id,
  expectedRevision: 7,
  set,
  ...extra,
});

describe("work-prioritizer binds core__work_item_update behind the guard", () => {
  it("offers the real tool contract: its name and the PATCH route's input schema", () => {
    const a = setup();
    expect(a.guard.name).toBe(WORK_ITEM_UPDATE_NAME);
    expect(a.guard.description).toBe(a.writer.description);
    expect(a.guard.schema).toBe(workItemUpdateContract.inputSchema);
  });

  it("writes status, scores and a goal link as one CAS patch, then keeps the new revision", async () => {
    const a = setup();
    a.read(item("task.1", { labels: ["area:ai"] }));
    const out = await a.call(
      update(
        "task.1",
        {
          status: "needs_implement",
          labels: ["area:ai", "goal:delivery"],
          scores: scores(3),
        },
        { reason: "route and score" },
      ),
    );
    expect(out).toContain('"revision"');
    expect(a.writes).toHaveLength(1);
    expect(a.writes[0]).toMatchObject({
      id: "task.1",
      expectedRevision: 7,
      reason: "route and score",
      set: { status: "needs_implement", labels: ["area:ai", "goal:delivery"] },
    });
    // The guard stored revision 8 and the new status: the old revision is stale.
    expect(
      await a.call(update("task.1", { scores: scores(2) })),
    ).toContain("expected_revision");
    expect(
      await a.call({
        id: "task.1",
        expectedRevision: 8,
        set: { scores: scores(2) },
      }),
    ).toContain('"revision"');
  });

  it("routes status and cancels with a reason; never done", async () => {
    const a = setup();
    for (const n of [1, 2, 3, 4]) a.read(item(`task.${n}`));
    expect(
      await a.call(update("task.1", { status: "needs_implement" })),
    ).toContain('"revision"');
    expect(
      await a.call(update("task.2", { status: "cancelled" })),
    ).toContain("cancel_needs_reason");
    expect(
      await a.call(
        update("task.2", { status: "cancelled" }, { reason: "Superseded by task.9" }),
      ),
    ).toContain('"revision"');
    expect(await a.call(update("task.3", { status: "done" }))).toContain(
      "route_not_allowed",
    );
    expect(
      await a.call(update("task.4", { status: "needs_triage" })),
    ).toContain("no_change");
    expect(a.writes.map((w) => (w.set as { status: string }).status)).toEqual([
      "needs_implement",
      "cancelled",
    ]);
  });

  it("sets only status, scores and labels", async () => {
    const a = setup();
    a.read(item("task.1", { labels: ["area:ai"] }));
    for (const extra of [
      { priority: 3 },
      { rank: 1 },
      { summary: "New" },
      { outcome: "New" },
      { title: "New" },
      { branch: "b" },
      { blockedBy: null },
    ])
      expect(
        await a.call(update("task.1", { scores: scores(3), ...extra })),
      ).toContain("field_not_allowed");
    // Drops an existing label.
    expect(
      await a.call(update("task.1", { labels: ["goal:delivery"] })),
    ).toContain("guard_rejected: labels");
    // Adds a label that is not a listed goal.
    expect(
      await a.call(update("task.1", { labels: ["area:ai", "goal:made-up"] })),
    ).toContain("guard_rejected: labels");
    expect(a.writes).toHaveLength(0);
  });

  it("needs evidence read this run for a score of 4-5, never the item's own page", async () => {
    const a = setup();
    const own = `${origin}/work/items/task.1`;
    a.read(item("task.1", { sourceUrl: own }));
    for (const ev of [
      undefined,
      "https://unknown.example/page",
      own,
      `${origin}/work/items/task.1/`,
      `${origin}/api/v1/work/items/task.1`,
    ])
      expect(
        await a.call(update("task.1", { scores: scores(4, ev) })),
      ).toContain("guard_rejected: evidence");
    expect(a.writes).toHaveLength(0);
    expect(
      await a.call(update("task.1", { scores: scores(4, source) })),
    ).toContain('"revision"');
    expect(a.writes).toHaveLength(1);
  });

  it("changes at most five distinct items per run", async () => {
    const a = setup();
    for (let n = 1; n <= 7; n++) {
      a.read(item(`task.${n}`));
      await a.call(update(`task.${n}`, { status: "needs_design" }));
    }
    expect(a.writes).toHaveLength(5);
  });

  it("requires the triage guide, goals and a fresh item read before any write", async () => {
    const noGuide = setup({ guidance: false });
    noGuide.read(item("task.1"));
    expect(
      await noGuide.call(update("task.1", { status: "needs_design" })),
    ).toContain("guard_rejected: guidance");
    const noGoals = setup({ goals: false });
    noGoals.read(item("task.1"));
    expect(
      await noGoals.call(update("task.1", { status: "needs_design" })),
    ).toContain("guard_rejected: goals");
    const a = setup();
    expect(
      await a.call(update("task.9", { status: "needs_design" })),
    ).toContain("item_not_read");
    a.read(item("task.2", { status: "done" }));
    expect(
      await a.call(update("task.2", { status: "needs_design" })),
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
      await a.call(
        update("task.1", {
          status: "needs_implement",
          labels: ["goal:delivery"],
          scores: scores(3),
        }),
      ),
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
      await a.call(update("task.1", { status: "needs_design" })),
    ).toContain('"revision"');
    // The unread item stays unwritable; only that item is affected.
    expect(
      await a.call(update("task.404", { status: "needs_design" })),
    ).toContain("item_not_read");
    expect(a.writes).toHaveLength(1);
  });
});

describe("audit reason, route source and uncertain writes", () => {
  it("fills a one-line reason when none is sent; keeps the model's own", async () => {
    const a = setup();
    a.read(item("task.1", { scores: { agent: { v: 5 } } }));
    a.read(item("task.2"));
    await a.call(
      update("task.1", {
        status: "needs_design",
        labels: ["goal:delivery"],
        scores: { ...scores(3), agent: { v: 1 } },
      }),
    );
    expect(a.writes[0]?.reason).toBe(
      "triage: status needs_triage→needs_design; scores agent 5→1, goal 0→3, time 0→2, unblocks 0→2, ease 0→3, confidence 0→3; +goal:delivery",
    );
    await a.call(
      update("task.2", { scores: scores(3) }, { reason: "model reason" }),
    );
    expect(a.writes[1]?.reason).toBe("model reason");
  });

  it("routes only from needs_triage, needs_research, needs_design and needs_implement", async () => {
    const a = setup();
    for (const status of [
      "needs_merge",
      "needs_closeout",
      "blocked",
      "done",
      "cancelled",
    ]) {
      a.read(item(`task.${status}`, { status }));
      expect(
        await a.call(update(`task.${status}`, { status: "needs_design" })),
      ).toContain("guard_rejected");
    }
    expect(
      await a.call(update("task.needs_merge", { status: "needs_design" })),
    ).toContain("route_source");
    for (const status of ["needs_research", "needs_design", "needs_implement"]) {
      a.read(item(`task.${status}`, { status }));
      expect(
        await a.call(
          update(
            `task.${status}`,
            { status: "cancelled" },
            { reason: "Not worth doing" },
          ),
        ),
      ).toContain('"revision"');
    }
    expect(a.writes).toHaveLength(3);
  });

  it("counts an uncertain write toward the five-item budget", async () => {
    const a = setup();
    const failing = new DynamicStructuredTool({
      name: WORK_ITEM_UPDATE_NAME,
      description: "Host writer",
      schema: z.object({}).passthrough(),
      func: async () => {
        throw new Error("network");
      },
    });
    const guard = createTriageGuard(a.receipts, failing, [TRIAGE_GUIDANCE_ID]);
    for (let n = 1; n <= 5; n++) {
      a.read(item(`task.${n}`));
      expect(
        await guard.invoke(update(`task.${n}`, { status: "needs_design" }) as never),
      ).toContain("write_result_uncertain");
    }
    a.read(item("task.6"));
    expect(
      await guard.invoke(update("task.6", { status: "needs_design" }) as never),
    ).toContain("write_budget");
  });
});

describe("partial scores, DTO receipts and conflicts", () => {
  it("a partial score patch keeps the other stored axes", async () => {
    const a = setup();
    a.read(item("task.1", { scores: scores(3) }));
    await a.call(update("task.1", { scores: { agent: { v: 1 } } }));
    expect(a.writes).toHaveLength(1);
    expect((a.writes[0]?.set as { scores: object }).scores).toEqual({
      ...scores(3),
      agent: { v: 1 },
    });
  });

  it("a partial score patch equal to the stored values writes nothing", async () => {
    const a = setup();
    a.read(item("task.1", { scores: scores(3) }));
    expect(
      await a.call(update("task.1", { scores: { goal: { v: 3 } } })),
    ).toBe("no_change");
    expect(a.writes).toHaveLength(0);
  });

  it("rebuilds the receipt from the returned item, not the input", async () => {
    const a = setup();
    a.read(item("task.1", { labels: ["area:ai"], scores: scores(3) }));
    await a.call(update("task.1", { status: "needs_design" }));
    const stored = a.receipts.items.get("task.1");
    // The fake host returns labels [] and no scores: the receipt follows the DTO.
    expect(stored).toMatchObject({ revision: 8, status: "needs_design", labels: [] });
    expect(stored?.scores).toBeUndefined();
  });

  it("a revision_conflict result advances nothing and spends no budget", async () => {
    const a = setup();
    const conflict = new DynamicStructuredTool({
      name: WORK_ITEM_UPDATE_NAME,
      description: "Host writer",
      schema: z.object({}).passthrough(),
      func: async () =>
        JSON.stringify({
          success: false,
          id: "task.1",
          code: "revision_conflict",
          currentRevision: 9,
          message: "moved",
        }),
    });
    const guard = createTriageGuard(a.receipts, conflict, [TRIAGE_GUIDANCE_ID]);
    for (let n = 1; n <= 6; n++) {
      a.read(item(`task.${n}`));
      expect(
        await guard.invoke(update(`task.${n}`, { status: "needs_design" }) as never),
      ).toContain("revision_conflict");
    }
    // Six conflicts: none counted toward the five-item budget, the receipt is unchanged.
    expect(a.receipts.items.get("task.1")).toMatchObject({ revision: 7, status: "needs_triage" });
    expect(
      await guard.invoke(update("task.6", { status: "needs_design" }) as never),
    ).toContain("revision_conflict");
  });
});

describe("a landed update counts as changed in the cycle report", () => {
  it("counts a successful update of an item whose scores were null", async () => {
    const a = setup();
    // The item had no scores (null on the store); the update sets all six axes, a label and a route.
    a.read(item("task.5", { status: "needs_design", scores: undefined }));
    const out = await a.call(
      update(
        "task.5",
        {
          status: "needs_research",
          labels: ["goal:delivery"],
          scores: scores(3),
        },
        { reason: "triage" },
      ),
    );
    expect(out).toContain('"revision"');
    // The host's tool result reaches observeTool as the item the route returns (no `success` key).
    a.hooks.observeTool(
      WORK_ITEM_UPDATE_NAME,
      {},
      {
        ok: true,
        value: {
          id: "task.5",
          status: "needs_research",
          revision: 8,
          rankScore: 4.2,
          labels: ["goal:delivery"],
          scores: scores(3),
        },
      },
    );
    const report = a.hooks.projectOutput("done") as {
      telemetry: { changedItemIds: string[]; changeCount: number; toolErrorCount: number };
    };
    expect(report.telemetry).toMatchObject({
      changedItemIds: ["task.5"],
      changeCount: 1,
      toolErrorCount: 0,
    });
  });
});
