// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The closeout program closes an item only with live proof (story.0035).
 * Deterministic: a fake host writer records what reaches the ToolRunner; no model runs.
 */
import { WORK_ITEM_UPDATE_NAME } from "@cogni/ai-tools";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCloseoutGuard } from "../../../src/graphs/work-closeout/closeout-guard";
import { createCloseoutRunHooks } from "../../../src/graphs/work-closeout/graph";
import type { CloseoutReceipts } from "../../../src/graphs/work-closeout/receipts";

const PR = "https://github.com/cogni-dao/node-template/pull/297";
const SHA = "a".repeat(40);
const item = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "bug",
  status: "needs_merge",
  revision: 3,
  createdAt: new Date().toISOString(),
  labels: [],
  summary: "Purge creator gates.",
  outcome: `Shipped in ${PR}.`,
  ...overrides,
});
const close = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  expectedRevision: 3,
  reason: `PR #297 merged as ${SHA.slice(0, 8)} and live in this build`,
  set: { status: "done", pr: PR },
  ...overrides,
});

function setup() {
  const hooks = createCloseoutRunHooks({ origin: "https://node.example" });
  const receipts = hooks.graphOptions.programState as CloseoutReceipts;
  const writes: Record<string, unknown>[] = [];
  const writer = new DynamicStructuredTool({
    name: WORK_ITEM_UPDATE_NAME,
    description: "Host writer",
    schema: z.object({}).passthrough(),
    func: async (value) => {
      writes.push(value);
      return JSON.stringify({ id: value.id, status: "done", revision: 4 });
    },
  });
  const guard = createCloseoutGuard(receipts, writer);
  const read = (value: ReturnType<typeof item>) =>
    hooks.observeTool("core__work_item_read", { id: value.id }, {
      ok: true,
      value: { item: value },
    });
  const pr = (merged: boolean, n = 297) =>
    hooks.observeTool(
      "core__vcs_pr_read",
      { owner: "Cogni-DAO", repo: "node-template", prNumber: n },
      { ok: true, value: { number: n, merged, mergeCommitSha: merged ? SHA : null } },
    );
  const live = (contains: boolean, refIsRunningBuild = true) =>
    hooks.observeTool(
      "core__vcs_commit_contains",
      { owner: "Cogni-DAO", repo: "node-template", commit: SHA },
      { ok: true, value: { commit: SHA, ref: "b".repeat(40), refIsRunningBuild, contains } },
    );
  const call = (input: Record<string, unknown>) =>
    guard.invoke(input as never) as Promise<string>;
  return { hooks, receipts, writes, guard, read, pr, live, call };
}

describe("closeout guard", () => {
  it("closes an item whose linked pull request is merged and live", async () => {
    const t = setup();
    t.read(item("bug.0019"));
    t.pr(true);
    t.live(true);
    const out = await t.call(close("bug.0019"));
    expect(out).toContain('"id":"bug.0019"');
    expect(t.writes).toHaveLength(1);
    expect(t.receipts.closed.has("bug.0019")).toBe(true);
    const report = t.hooks.projectOutput("closed bug.0019");
    expect(report.telemetry).toMatchObject({ changeCount: 1, aborted: false });
  });

  it("counts a close when the agent calls it as a tool call (the writer then returns a ToolMessage)", async () => {
    const t = setup();
    t.read(item("bug.0019"));
    t.pr(true);
    t.live(true);
    await t.guard.invoke({
      id: "call-1",
      name: WORK_ITEM_UPDATE_NAME,
      args: close("bug.0019"),
      type: "tool_call",
    } as never);
    expect(t.writes).toHaveLength(1);
    expect(t.receipts.closed.has("bug.0019")).toBe(true);
  });

  it("refuses without a live receipt for the running build", async () => {
    for (const [merged, contains, running] of [
      [false, true, true],
      [true, false, true],
      [true, true, false],
    ] as const) {
      const t = setup();
      t.read(item("bug.0019"));
      t.pr(merged);
      t.live(contains, running);
      expect(await t.call(close("bug.0019"))).toContain("not_live");
      expect(t.writes).toHaveLength(0);
    }
  });

  it("refuses a pull request the item does not link", async () => {
    const t = setup();
    t.read(item("bug.0019", { outcome: "See https://github.com/cogni-dao/node-template/pull/2970" }));
    t.pr(true);
    t.live(true);
    expect(await t.call(close("bug.0019"))).toContain("pr_not_linked");
  });

  it("allows only the closeout write shape, from a delivery status, at the read revision", async () => {
    const t = setup();
    t.read(item("bug.0019"));
    t.pr(true);
    t.live(true);
    expect(
      await t.call(close("bug.0019", { set: { status: "done", pr: PR, priority: 0 } })),
    ).toContain("write_shape");
    expect(
      await t.call(close("bug.0019", { set: { status: "cancelled", pr: PR } })),
    ).toContain("write_shape");
    expect(await t.call(close("bug.0019", { expectedRevision: 2 }))).toContain("expected_revision");
    t.read(item("bug.0020", { status: "needs_triage" }));
    expect(await t.call(close("bug.0020"))).toContain("status_source");
    expect(await t.call(close("bug.0021"))).toContain("item_not_read");
    // task.0122: deployVerified is never written, and closeout never closes from needs_implement or a review queue.
    expect(
      await t.call(close("bug.0019", { set: { status: "done", deployVerified: true, pr: PR } })),
    ).toContain("write_shape");
    for (const status of ["needs_implement", "needs_implementation_review", "needs_validation", "blocked"]) {
      t.read(item("bug.0022", { status }));
      expect(await t.call(close("bug.0022"))).toContain("status_source");
    }
    expect(t.writes).toHaveLength(0);
    expect(t.receipts.refused).toBe(10);
  });

  it("does not close a legacy needs_closeout item: the placement job moves it first", async () => {
    const t = setup();
    t.read(item("bug.0023", { status: "needs_closeout" }));
    t.pr(true);
    t.live(true);
    expect(await t.call(close("bug.0023"))).toContain("status_source");
    expect(t.writes).toHaveLength(0);
  });

  it("closes at most five items per run", async () => {
    const t = setup();
    t.pr(true);
    t.live(true);
    for (let n = 1; n <= 6; n++) t.read(item(`task.000${n}`));
    for (let n = 1; n <= 5; n++)
      expect(await t.call(close(`task.000${n}`))).toContain(`task.000${n}`);
    expect(await t.call(close("task.0006"))).toContain("write_budget");
    expect(t.writes).toHaveLength(5);
  });

  it("reports the closed items when the step budget ends the run", () => {
    const t = setup();
    t.receipts.closed.add("bug.0019");
    const budget = t.hooks.projectStepBudget();
    expect(budget.answer).toContain("Closed 1 item(s): bug.0019");
    expect(budget.output.telemetry).toMatchObject({ aborted: true, abortReason: "step_budget" });
  });
});
