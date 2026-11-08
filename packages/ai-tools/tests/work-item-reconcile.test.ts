// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/work-item-reconcile`
 * Purpose: Host checks of the steward-only tools (task.0054): the reconcile writer and the history read.
 * Scope: Capability stubs only. Proves the host refuses a changed `Goal =` line even when a guard passed,
 *   writes only `summary` and `outcome` with CAS and the guard's reason, and reports absent history as unknown.
 * Invariants: APPROVED_LINES_BYTE_IDENTICAL, CAS_ALWAYS, TWO_FIELDS_ONLY, UNKNOWN_IS_NOT_EMPTY
 * Side-effects: none
 * Links: src/tools/work-item-reconcile.ts, src/tools/work-item-history.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  type WorkItemCapability,
  type WorkItemInfo,
  WorkItemPatchConflictError,
} from "../src/capabilities/work-item";
import { CORE_TOOL_BUNDLE } from "../src/catalog";
import { createWorkItemHistoryImplementation } from "../src/tools/work-item-history";
import {
  approvedLinesOf,
  createWorkItemReconcileImplementation,
  WORK_ITEM_RECONCILE_NAME,
  WorkItemReconcileOutputSchema,
} from "../src/tools/work-item-reconcile";
import { WorkItemTransitionInputSchema } from "../src/tools/work-item-transition";

const OUTCOME = [
  "Goal = The worst briefs get reconciled without human editing",
  "Done when = A run writes one guarded patch with a reason.",
  "[ ] Design is reviewed.",
].join("\n");
const STORED: WorkItemInfo = {
  id: "task.5001",
  type: "task",
  title: "A task",
  status: "needs_implement",
  summary: "Old summary.",
  outcome: OUTCOME,
  labels: [],
  assignees: [],
  externalRefs: [],
  specRefs: [],
  updatedAt: "2026-10-21T00:00:00.000Z",
  revision: 7,
  createdAt: "2026-10-20T00:00:00.000Z",
  deployVerified: false,
};
const REASON = "reconcile brief: long_sentences, log_block";
const input = (over: Record<string, unknown> = {}) => ({
  id: "task.5001",
  expectedRevision: 7,
  summary: "New summary.",
  outcome: OUTCOME.replace("[ ] Design is reviewed.", "[ ] Design is reviewed by the owner."),
  reason: REASON,
  ...over,
});

function capability(
  stored: WorkItemInfo | null = STORED,
  patch: WorkItemCapability["patch"] = async (p) => ({
    ...STORED,
    revision: 8,
    summary: p.set.summary,
  }),
) {
  const patchFn = vi.fn(patch);
  const cap: WorkItemCapability = {
    query: vi.fn().mockResolvedValue(stored ? [stored] : []),
    transitionStatus: vi.fn(),
    patch: patchFn,
  };
  return { cap, patchFn };
}

describe("core__work_item_reconcile", () => {
  it("patches summary and outcome with CAS and the guard's reason, nothing else", async () => {
    const { cap, patchFn } = capability();
    const out = WorkItemReconcileOutputSchema.parse(
      await createWorkItemReconcileImplementation({ workItemCapability: cap }).execute(input()),
    );
    expect(out).toMatchObject({ success: true, action: "reconcile", id: "task.5001", revision: 8 });
    expect(patchFn).toHaveBeenCalledTimes(1);
    const call = patchFn.mock.calls[0]?.[0];
    expect(call).toMatchObject({ id: "task.5001", expectedRevision: 7, reason: REASON });
    expect(Object.keys(call?.set ?? {}).sort()).toEqual(["outcome", "summary"]);
  });

  it("refuses a changed Goal = line even though a guard passed, and writes nothing", async () => {
    const { cap, patchFn } = capability();
    const impl = createWorkItemReconcileImplementation({ workItemCapability: cap });
    for (const outcome of [
      OUTCOME.replace("worst briefs", "best briefs"),
      OUTCOME.replace("Done when = A run writes one guarded patch with a reason.\n", ""),
      `${OUTCOME}\nGoal = A second goal`,
      OUTCOME.replace("Goal = ", "Goal  = "),
    ]) {
      const out = WorkItemReconcileOutputSchema.parse(await impl.execute(input({ outcome })));
      expect(out).toMatchObject({ success: false, code: "approved_lines_changed" });
    }
    expect(patchFn).not.toHaveBeenCalled();
  });

  it("returns a result, never a write, for a moved revision, a closed item and a missing item", async () => {
    const moved = capability({ ...STORED, revision: 9 });
    expect(
      await createWorkItemReconcileImplementation({ workItemCapability: moved.cap }).execute(input()),
    ).toMatchObject({ success: false, code: "revision_conflict", currentRevision: 9 });
    const closed = capability({ ...STORED, status: "done" });
    expect(
      await createWorkItemReconcileImplementation({ workItemCapability: closed.cap }).execute(input()),
    ).toMatchObject({ success: false, code: "item_closed" });
    const missing = capability(null);
    expect(
      await createWorkItemReconcileImplementation({ workItemCapability: missing.cap }).execute(input()),
    ).toMatchObject({ success: false, code: "not_found" });
    for (const x of [moved, closed, missing]) expect(x.patchFn).not.toHaveBeenCalled();
  });

  it("turns a lost compare-and-set into a result", async () => {
    const lost = capability(STORED, async () => {
      throw new WorkItemPatchConflictError("task.5001", 7, 8);
    });
    expect(
      await createWorkItemReconcileImplementation({ workItemCapability: lost.cap }).execute(input()),
    ).toMatchObject({ success: false, code: "revision_conflict", currentRevision: 8 });
  });

  it("accepts only a guard-shaped reason and a required revision", async () => {
    const { cap, patchFn } = capability();
    const impl = createWorkItemReconcileImplementation({ workItemCapability: cap });
    await expect(impl.execute(input({ reason: "pwned" }))).rejects.toThrow();
    await expect(impl.execute(input({ reason: undefined }))).rejects.toThrow();
    await expect(impl.execute(input({ expectedRevision: undefined }))).rejects.toThrow();
    expect(patchFn).not.toHaveBeenCalled();
  });

  it("shares one approved-line parser with the scorer: only exact Goal = and Done when = lines count", () => {
    expect(approvedLinesOf(`${OUTCOME}\r\nnote Goal = not a line\n Goal = indented`)).toEqual([
      "Goal = The worst briefs get reconciled without human editing",
      "Done when = A run writes one guarded patch with a reason.",
    ]);
  });

  it("core__work_item_transition still cannot carry an outcome", () => {
    expect(Object.keys(WorkItemTransitionInputSchema.shape)).not.toContain("outcome");
    expect(CORE_TOOL_BUNDLE.map((t) => t.contract.name)).toContain(WORK_ITEM_RECONCILE_NAME);
  });
});

describe("core__work_item_history", () => {
  it("returns versions without field values", async () => {
    const cap = {
      ...capability().cap,
      history: vi.fn().mockResolvedValue([
        { version: "8", at: "2026-11-01T00:00:00.000Z", actor: "agent", reason: REASON, extra: "dropped" },
      ]),
    } as WorkItemCapability;
    const out = await createWorkItemHistoryImplementation({ workItemCapability: cap }).execute({
      id: "task.5001",
    });
    expect(out).toEqual({
      available: true,
      versions: [{ version: "8", at: "2026-11-01T00:00:00.000Z", actor: "agent", reason: REASON }],
    });
  });

  it("an absent history port is unknown, never an empty log", async () => {
    const out = await createWorkItemHistoryImplementation({
      workItemCapability: capability().cap,
    }).execute({ id: "task.5001" });
    expect(out).toEqual({ available: false, versions: [] });
    const undef = {
      ...capability().cap,
      history: vi.fn().mockResolvedValue(undefined),
    } as WorkItemCapability;
    expect(
      await createWorkItemHistoryImplementation({ workItemCapability: undef }).execute({
        id: "task.5001",
      }),
    ).toEqual({ available: false, versions: [] });
  });
});
