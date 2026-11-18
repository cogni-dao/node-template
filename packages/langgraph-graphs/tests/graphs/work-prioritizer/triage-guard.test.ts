// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The prioritizer binds core__work_item_update (the PATCH route's twin) behind a thin guard (task.0065).
 * Deterministic: a fake host writer records what reaches the ToolRunner; no model runs.
 */
import {
  WORK_ITEM_ARTIFACT_RECORD_NAME,
  WORK_ITEM_UPDATE_NAME,
  workItemUpdateContract,
} from "@cogni/ai-tools";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPrioritizerRunHooks } from "../../../src/graphs/work-prioritizer/graph";
import { TRIAGE_GUIDANCE_ID } from "../../../src/graphs/work-prioritizer/prompts";
import type { RunReceipts } from "../../../src/graphs/work-prioritizer/receipts";
import { createTriageArtifactGuard } from "../../../src/graphs/work-prioritizer/triage-artifact-guard";
import { createTriageGuard } from "../../../src/graphs/work-prioritizer/triage-guard";

const origin = "https://node.example";
const source = `${origin}/knowledge/work-item-scores-design`;
const metricId = "convergence-ratio-7d";
const metricCatalog = {
  goals: [],
  asOf: "2026-11-12T00:00:00.000Z",
  environment: "local",
  orphans: [],
  unbound: [
    {
      metric: {
        id: metricId,
        title: "Convergence",
        calculatorId: "work.convergence@1",
      },
      assessment: null,
      latest: {
        viewState: "unavailable",
        value: null,
        unit: "ratio",
        observedAt: null,
        reason: "insufficient_history",
      },
    },
  ],
};
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
    hooks.observeTool(
      "core__goal_list",
      {},
      {
        ok: true,
        value: {
          goals: [
            { id: "goal-delivery", content: "Deliver", sourceUrl: source },
          ],
        },
      },
    );
  if (opts.guidance !== false)
    for (const id of [TRIAGE_GUIDANCE_ID, "work-item-scores-design"])
      hooks.observeTool(
        "core__knowledge_read",
        { id },
        {
          ok: true,
          value: { mode: "get", entries: [{ id, content: `guide ${id}` }] },
        },
      );
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
        moves: set.moves,
        revision:
          typeof value.expectedRevision === "number"
            ? value.expectedRevision + 1
            : undefined,
      });
    },
  });
  const guard = createTriageGuard(receipts, writer, [TRIAGE_GUIDANCE_ID]);
  const read = (value: ReturnType<typeof item>) =>
    hooks.observeTool(
      "core__work_item_read",
      { id: value.id },
      {
        ok: true,
        value: { item: value },
      },
    );
  /** The call without a recorded triage artifact: what a model that skips the artifact tool does. */
  const callRaw = (input: Record<string, unknown>) => guard.invoke(input as never);
  // Most cases are about the other rules, so `call` records the triage artifact the way the model must (task.0122); the
  // cases about the artifact itself use `callRaw` and the artifact guard.
  const ROUTE_VERDICT: Record<string, string> = {
    needs_research: "research",
    needs_design: "design",
    needs_implement: "implement",
  };
  const call = (input: Record<string, unknown>) => {
    const id = input.id as string;
    const status = (input.set as { status?: string } | undefined)?.status;
    const stored = receipts.items.get(id);
    if (status && ROUTE_VERDICT[status] && stored?.status === "needs_triage")
      receipts.triageRecorded.set(id, ROUTE_VERDICT[status] as string);
    return callRaw(input);
  };

  // The artifact tool's host writer: records what reaches the ToolRunner and answers like the route (201 { artifact }).
  const artifactWrites: Record<string, unknown>[] = [];
  const artifactWriter = new DynamicStructuredTool({
    name: WORK_ITEM_ARTIFACT_RECORD_NAME,
    description: "Host artifact writer",
    schema: z.object({}).passthrough(),
    func: async (value) => {
      artifactWrites.push(value);
      const artifact = (value.artifact ?? {}) as Record<string, unknown>;
      return JSON.stringify({ artifact: { ...artifact, id: "wia-1", itemId: value.id, seq: 1, itemRevision: 7, author: "p", createdAt: "x" } });
    },
  });
  const artifactGuard = createTriageArtifactGuard(receipts, artifactWriter, [TRIAGE_GUIDANCE_ID]);
  const record = (id: string, artifact: Record<string, unknown>) =>
    artifactGuard.invoke({ id, artifact } as never);
  return { hooks, receipts, writes, writer, guard, read, call, callRaw, artifactWrites, record };
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
  reason: "triage this item",
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

  it("returns all missing metric and score evidence together before any write", async () => {
    const a = setup();
    a.read(item("task.1"));
    const input = update("task.1", {
      moves: [{ metricId, direction: "up" }],
      scores: { ...scores(5), confidence: { v: 4 }, agent: { v: 5 } },
    });
    const refused = await a.call(input);
    for (const issue of [
      "metric_catalog:",
      "metric_not_read:",
      "metric_goal_evidence:",
      "goal 5",
      "confidence 4",
      "agent 5",
    ])
      expect(refused).toContain(issue);
    expect(a.writes).toHaveLength(0);
    a.hooks.observeTool(
      "core__goal_progress",
      {},
      { ok: true, value: metricCatalog },
    );
    a.hooks.observeTool(
      "core__knowledge_read",
      { id: metricId },
      {
        ok: true,
        value: {
          mode: "get",
          entries: [{ id: metricId, content: "Share of validated work." }],
        },
      },
    );
    const fixed = update("task.1", {
      moves: [{ metricId, direction: "up" }],
      scores: {
        ...scores(5, `${origin}/knowledge/${metricId}`),
        confidence: { v: 4, ev: source },
        agent: { v: 5, ev: source },
      },
    });
    expect(await a.call(fixed)).toContain('"revision"');
    expect(a.writes).toHaveLength(1);
  });

  it("bounds repair feedback even when the wire schema admits many score keys", async () => {
    const a = setup();
    a.read(item("task.1"));
    const scores = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        `unsupported-${i}-${"x".repeat(400)}`,
        { v: 5 },
      ]),
    );
    const out = await a.call(update("task.1", { scores }));
    expect(out).toContain("guard_rejected:");
    expect(out).toContain("988 additional evidence defects omitted");
    expect(out.length).toBeLessThan(4096);
    expect(a.writes).toHaveLength(0);
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
    expect(await a.call(update("task.1", { scores: scores(2) }))).toContain(
      "expected_revision",
    );
    expect(
      await a.call({
        id: "task.1",
        expectedRevision: 8,
        reason: "rescore",
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
      await a.call(
        update(
          "task.2",
          { status: "cancelled" },
          { reason: "Superseded by task.9" },
        ),
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

  it("writes moves, and a repeat of the same moves writes nothing", async () => {
    const a = setup();
    a.hooks.observeTool(
      "core__goal_progress",
      {},
      { ok: true, value: metricCatalog },
    );
    a.hooks.observeTool(
      "core__knowledge_read",
      { id: metricId },
      {
        ok: true,
        value: {
          mode: "get",
          entries: [{ id: metricId, content: "Share of validated work." }],
        },
      },
    );
    a.read(item("task.1"));
    const moves = [{ metricId: "convergence-ratio-7d", direction: "up" }];
    expect(await a.call(update("task.1", { moves }))).toContain('"revision"');
    expect(a.writes).toHaveLength(1);
    expect(a.writes[0]).toMatchObject({ set: { moves } });
    // An empty list is a change from a stored list, and the same list again is not.
    expect(
      await a.call({
        id: "task.1",
        expectedRevision: 8,
        reason: "no metric fits",
        set: { moves: [] },
      }),
    ).toContain('"revision"');
    a.read(item("task.2", { moves }));
    expect(await a.call(update("task.2", { moves }))).toContain("no_change");
    expect(a.writes).toHaveLength(2);
    // An item that never declared moves takes `[]` as a real change; a declared `[]` repeats as no change.
    a.read(item("task.3"));
    expect(
      await a.call(
        update("task.3", { moves: [] }, { reason: "no metric fits" }),
      ),
    ).toContain('"revision"');
    a.read(item("task.4", { moves: [] }));
    expect(await a.call(update("task.4", { moves: [] }))).toContain(
      "no_change",
    );
    expect(a.writes).toHaveLength(3);
  });
  it("requires canonical metric discovery and the metric body before a new declaration", async () => {
    const a = setup();
    a.read(item("task.1"));
    const input = update("task.1", { moves: [{ metricId, direction: "up" }] });
    expect(await a.call(input)).toContain("metric_catalog");
    expect(a.writes).toHaveLength(0);
    a.hooks.observeTool(
      "core__goal_progress",
      {},
      { ok: true, value: { goals: [] } },
    );
    expect(await a.call(input)).toContain("metric_catalog");
    a.hooks.observeTool(
      "core__goal_progress",
      {},
      { ok: true, value: metricCatalog },
    );
    expect(await a.call(input)).toContain("metric_not_read");
    a.hooks.observeTool(
      "core__knowledge_read",
      { id: metricId },
      {
        ok: true,
        value: {
          mode: "get",
          entries: [{ id: metricId, content: "Share of validated work." }],
        },
      },
    );
    expect(
      await a.call(
        update("task.1", {
          moves: [{ metricId, direction: "up" }],
          scores: { goal: { v: 5, ev: source } },
        }),
      ),
    ).toContain("metric_goal_evidence");
    expect(
      await a.call(
        update("task.1", {
          moves: [{ metricId, direction: "up" }],
          scores: { goal: { v: 5, ev: `${origin}/knowledge/${metricId}` } },
        }),
      ),
    ).toContain('"revision"');
    expect(a.writes).toHaveLength(1);
  });
  it("checks retained high goal scores when only moves changes", async () => {
    const a = setup();
    a.read(item("task.1", { scores: { goal: { v: 4, ev: source } } }));
    a.hooks.observeTool(
      "core__goal_progress",
      {},
      { ok: true, value: metricCatalog },
    );
    a.hooks.observeTool(
      "core__knowledge_read",
      { id: metricId },
      {
        ok: true,
        value: {
          mode: "get",
          entries: [{ id: metricId, content: "Share of validated work." }],
        },
      },
    );
    expect(
      await a.call(
        update("task.1", { moves: [{ metricId, direction: "up" }] }),
      ),
    ).toContain("metric_goal_evidence");
    expect(a.writes).toHaveLength(0);
  });
  it("cannot declare no fitting metrics from unavailable or partial discovery", async () => {
    const a = setup();
    a.read(item("task.1"));
    a.hooks.observeTool(
      "core__goal_progress",
      {},
      {
        ok: true,
        value: {
          ...metricCatalog,
          servedUnavailable: "metric_authority_unavailable",
        },
      },
    );
    expect(await a.call(update("task.1", { moves: [] }))).toContain(
      "metric_catalog",
    );
    a.hooks.observeTool(
      "core__goal_progress",
      {},
      { ok: true, value: { ...metricCatalog, servedTruncated: true } },
    );
    expect(await a.call(update("task.1", { moves: [] }))).toContain(
      "metric_catalog_incomplete",
    );
    expect(a.writes).toHaveLength(0);
  });

  it("retains a null direction when recording an item for triage", async () => {
    const a = setup();
    const moves = [{ metricId: "repair-metric", direction: null }];
    a.read(item("task.1", { moves }));
    expect(a.receipts.items.get("task.1")?.moves).toEqual(moves);
    expect(await a.call(update("task.1", { moves }))).toBe("no_change");
    expect(
      await a.call(update("task.1", { status: "needs_implement" })),
    ).toContain('"revision"');
    expect(a.writes[0]).toMatchObject({ set: { status: "needs_implement" } });
  });

  it("sets only status, scores, labels and moves", async () => {
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
    a.hooks.observeTool(
      "core__work_item_read",
      { id: "task.404" },
      {
        ok: false,
        errorCode: "not_found",
      },
    );
    a.hooks.observeTool(
      "core__knowledge_read",
      { id: "agent-human-boundary" },
      {
        ok: false,
        errorCode: "not_found",
      },
    );
    a.hooks.observeTool(
      "core__work_item_read",
      { id: "task.5" },
      {
        ok: true,
        value: { item: null },
      },
    );
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
  it("refuses a write with no reason, and never writes one for the model (task.0086)", async () => {
    const a = setup();
    a.read(item("task.1"));
    a.receipts.triageRecorded.set("task.1", "design");
    // The tool schema stops a missing reason first; the guard's own check covers a direct call.
    const direct = (input: Record<string, unknown>) =>
      (a.guard as unknown as { func: (i: unknown) => Promise<string> }).func(
        input,
      );
    for (const reason of [undefined, "", "  "]) {
      const input = update("task.1", { status: "needs_design" });
      expect(await direct({ ...input, reason })).toContain("reason_required");
    }
    await expect(
      a.call({
        id: "task.1",
        expectedRevision: 7,
        set: { status: "needs_design" },
      }),
    ).rejects.toThrow(/reason is required/);
    expect(a.writes).toHaveLength(0);
  });

  it("sends the model's own reason to the writer unchanged", async () => {
    const a = setup();
    a.read(item("task.2"));
    await a.call(
      update("task.2", { scores: scores(3) }, { reason: "model reason" }),
    );
    expect(a.writes[0]?.reason).toBe("model reason");
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
    for (const status of [
      "needs_research",
      "needs_design",
      "needs_implement",
    ]) {
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

  it("routes only from needs_triage, and sends a later item back to needs_triage or cancels it (task.0122)", async () => {
    const a = setup();
    a.read(item("task.designing", { status: "needs_design" }));
    // A later status moves on its own review artifact, not on triage.
    expect(await a.call(update("task.designing", { status: "needs_implement" }))).toContain("route_source");
    expect(await a.call(update("task.designing", { status: "needs_research" }))).toContain("route_source");
    expect(a.writes).toHaveLength(0);
    // Triage may send it back to needs_triage.
    expect(
      await a.call(update("task.designing", { status: "needs_triage" }, { reason: "the route was wrong" })),
    ).toContain('"revision"');
    // From needs_triage only the routes.
    a.read(item("task.fresh", { status: "needs_triage" }));
    expect(await a.call(update("task.fresh", { status: "needs_merge" }))).toContain("route_not_allowed");
    expect(await a.call(update("task.fresh", { status: "done" }))).toContain("route_not_allowed");
    expect(a.writes).toHaveLength(1);
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
      a.receipts.triageRecorded.set(`task.${n}`, "design");
      expect(
        await guard.invoke(
          update(`task.${n}`, { status: "needs_design" }) as never,
        ),
      ).toContain("write_result_uncertain");
    }
    a.read(item("task.6"));
    a.receipts.triageRecorded.set("task.6", "design");
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
    expect(
      (a.writes[0]?.set as { scores: object } | undefined)?.scores,
    ).toEqual({
      ...scores(3),
      agent: { v: 1 },
    });
  });

  it("a partial score patch equal to the stored values writes nothing", async () => {
    const a = setup();
    a.read(item("task.1", { scores: scores(3) }));
    expect(await a.call(update("task.1", { scores: { goal: { v: 3 } } }))).toBe(
      "no_change",
    );
    expect(a.writes).toHaveLength(0);
  });

  it("rebuilds the receipt from the returned item, not the input", async () => {
    const a = setup();
    a.read(item("task.1", { labels: ["area:ai"], scores: scores(3) }));
    await a.call(update("task.1", { status: "needs_design" }));
    const stored = a.receipts.items.get("task.1");
    // The fake host returns labels [] and no scores: the receipt follows the DTO.
    expect(stored).toMatchObject({
      revision: 8,
      status: "needs_design",
      labels: [],
    });
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
      a.receipts.triageRecorded.set(`task.${n}`, "design");
      expect(
        await guard.invoke(
          update(`task.${n}`, { status: "needs_design" }) as never,
        ),
      ).toContain("revision_conflict");
    }
    // Six conflicts: none counted toward the five-item budget, the receipt is unchanged.
    expect(a.receipts.items.get("task.1")).toMatchObject({
      revision: 7,
      status: "needs_triage",
    });
    expect(
      await guard.invoke(update("task.6", { status: "needs_design" }) as never),
    ).toContain("revision_conflict");
  });
});

describe("a landed update counts as changed in the cycle report", () => {
  it("counts a successful update of an item whose scores were null", async () => {
    const a = setup();
    // The item had no scores (null on the store); the update sets all six axes, a label and a route.
    a.read(item("task.5", { status: "needs_triage", scores: undefined }));
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
      telemetry: {
        changedItemIds: string[];
        changeCount: number;
        toolErrorCount: number;
      };
    };
    expect(report.telemetry).toMatchObject({
      changedItemIds: ["task.5"],
      changeCount: 1,
      toolErrorCount: 0,
    });
  });
});

describe("the triage artifact comes first (task.0122)", () => {
  const triage = (id: string, verdict: string, extra: Record<string, unknown> = {}) => ({
    kind: "triage",
    subject: `work:${id}`,
    verdict,
    ...extra,
  });
  const route = (id: string, status: string) =>
    ({ id, expectedRevision: 7, reason: "route it", set: { status } });

  it("refuses to route an item forward before its triage artifact is recorded", async () => {
    const a = setup();
    a.read(item("task.1"));
    const out = await a.callRaw(route("task.1", "needs_implement"));
    expect(out).toContain("triage_artifact");
    expect(out).toContain(WORK_ITEM_ARTIFACT_RECORD_NAME);
    expect(a.writes).toHaveLength(0);
  });

  it("routes the item forward after the triage artifact for that route is recorded", async () => {
    const a = setup();
    a.read(item("task.1"));
    const recorded = await a.record("task.1", triage("task.1", "implement"));
    expect(recorded).toContain('"artifact"');
    expect(a.artifactWrites).toEqual([
      { id: "task.1", artifact: triage("task.1", "implement") },
    ]);
    expect(await a.callRaw(route("task.1", "needs_implement"))).toContain('"revision"');
    expect(a.writes).toHaveLength(1);
  });

  it("a triage artifact for another route does not open the route the model asks for", async () => {
    const a = setup();
    a.read(item("task.1"));
    await a.record("task.1", triage("task.1", "design"));
    expect(await a.callRaw(route("task.1", "needs_implement"))).toContain("triage_artifact");
    expect(await a.callRaw(route("task.1", "needs_design"))).toContain('"revision"');
  });

  it("a triage artifact of one item does not open another item", async () => {
    const a = setup();
    a.read(item("task.1"));
    a.read(item("task.2"));
    await a.record("task.1", triage("task.1", "implement"));
    expect(await a.callRaw(route("task.2", "needs_implement"))).toContain("triage_artifact");
  });

  it("cancelling and moving back to triage need no artifact", async () => {
    const a = setup();
    a.read(item("task.1"));
    expect(
      await a.callRaw({ id: "task.1", expectedRevision: 7, reason: "no fit", set: { status: "cancelled" } }),
    ).toContain('"revision"');
  });

  it("records only a triage artifact of this item, for an item in needs_triage, after the guide and goals", async () => {
    const a = setup();
    a.read(item("task.1"));
    a.read(item("task.2", { status: "needs_design" }));
    for (const [id, artifact, code] of [
      [
        "task.1",
        {
          kind: "design_review",
          subject: "knowledge:contrib-design-0001@0123456789abcdefghijklmnopqrstuv",
          verdict: "approve",
          url: "https://example.test/review",
        },
        "artifact_shape",
      ],
      ["task.1", triage("task.2", "implement"), "artifact_shape"],
      ["task.2", triage("task.2", "implement"), "artifact_source"],
      ["task.9", triage("task.9", "implement"), "item_not_read"],
    ] as const) {
      expect(await a.record(id, artifact as never), `${id} ${code}`).toContain(code);
    }
    expect(a.artifactWrites).toHaveLength(0);
    const cold = setup({ guidance: false });
    cold.read(item("task.1"));
    expect(await cold.record("task.1", triage("task.1", "implement"))).toContain("guidance");
    const noGoals = setup({ goals: false });
    noGoals.read(item("task.1"));
    expect(await noGoals.record("task.1", triage("task.1", "implement"))).toContain("goals");
  });

  it("records at most five items per run", async () => {
    const a = setup();
    for (let n = 1; n <= 6; n++) a.read(item(`task.${n}`));
    for (let n = 1; n <= 5; n++)
      expect(await a.record(`task.${n}`, triage(`task.${n}`, "implement"))).toContain('"artifact"');
    expect(await a.record("task.6", triage("task.6", "implement"))).toContain("write_budget");
    // The same item may be re-recorded: the latest artifact decides.
    expect(await a.record("task.1", triage("task.1", "design"))).toContain('"artifact"');
    expect(a.artifactWrites).toHaveLength(6);
  });

  it("a refused artifact write does not open the route", async () => {
    const a = setup();
    a.read(item("task.1"));
    const refusing = createTriageArtifactGuard(
      a.receipts,
      new DynamicStructuredTool({
        name: WORK_ITEM_ARTIFACT_RECORD_NAME,
        description: "Host artifact writer",
        schema: z.object({}).passthrough(),
        func: async () => JSON.stringify({ success: false, id: "task.1", status: 503, code: "artifacts_unavailable", message: "m" }),
      }),
      [TRIAGE_GUIDANCE_ID],
    );
    await refusing.invoke({ id: "task.1", artifact: triage("task.1", "implement") } as never);
    expect(await a.callRaw(route("task.1", "needs_implement"))).toContain("triage_artifact");
  });
});
