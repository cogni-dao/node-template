// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/work-item-tool-envelope.conformance`
 * Purpose: Prove the agent tool `core__work_item_query` returns the same stable
 *   context envelope an external agent reads from GET /api/v1/work/items (bug.5552).
 * Scope: The 14 pinned planner fields of the tool output conform, key-for-key and
 *   type-for-type, to node-contracts `WorkItemDtoSchema`. ai-tools runs zod 3 and
 *   node-contracts runs zod 4; the zod-4 schema parses the tool's plain output as
 *   DATA, so the two majors never clash. Does not test HTTP transport.
 * Invariants: ENVELOPE_PARITY — the pinned subset matches the wire DTO; a dropped
 *   or mistyped pinned field fails the oracle; list and by-ids share one key-set.
 * Side-effects: none
 * Links: packages/ai-tools/src/tools/work-item-query.ts, bug.5552
 * @internal
 */

import {
  createWorkItemQueryImplementation,
  type WorkItemCapability,
  type WorkItemInfo,
  type WorkItemQueryOutput,
} from "@cogni/ai-tools";
import { WorkItemDtoSchema, type WorkItemDto } from "@cogni/node-contracts";
import { describe, expect, it, vi } from "vitest";

/**
 * The pinned context envelope (bug.5552): the state a prioritizer reasons over.
 * assignees / externalRefs / revision / specRefs and the tool-only presentational
 * fields (sourceUrl, title, summary, outcome) are deliberately out of this guard.
 */
const ENVELOPE_FIELDS = {
  id: true,
  type: true,
  status: true,
  priority: true,
  rank: true,
  rankScore: true,
  scores: true,
  labels: true,
  blockedBy: true,
  branch: true,
  pr: true,
  createdAt: true,
  updatedAt: true,
  deployVerified: true,
} as const;

// A non-strict z.object: .pick(...).parse() strips the tool-only extras and
// validates exactly the pinned fields, so it passes when correct and throws when
// any pinned field is dropped or mistyped.
const EnvelopeSchema = WorkItemDtoSchema.pick(ENVELOPE_FIELDS);

// Compile-time envelope parity (bug.5552 acceptance #2): tsc fails if the tool
// output drops or retypes any pinned field — including the OPTIONAL ones the
// runtime .pick().parse() oracle cannot catch. Each `item.<field>` read errors if
// the field is absent from the tool type; each property errors if the type is
// incompatible with Pick<WorkItemDto, …>. Never called; existence type-checks it.
type ToolEnvelope = WorkItemQueryOutput["items"][number];
type PinnedDto = Pick<WorkItemDto, keyof typeof ENVELOPE_FIELDS>;
export const _envelopeTypeParity = (item: ToolEnvelope): PinnedDto => ({
  id: item.id,
  type: item.type,
  status: item.status,
  priority: item.priority,
  rank: item.rank,
  rankScore: item.rankScore,
  scores: item.scores,
  labels: item.labels,
  blockedBy: item.blockedBy,
  branch: item.branch,
  pr: item.pr,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  deployVerified: item.deployVerified,
});

const ITEM: WorkItemInfo = {
  id: "task.0007",
  type: "task",
  title: "Enrich the envelope",
  status: "needs_implement",
  priority: 2,
  rank: 1,
  rankScore: 0.42,
  scores: { goal: { v: 5, ev: "https://e.test/x" }, time: { v: 3 } },
  labels: ["goal", "area:tools"],
  assignees: [{ kind: "agent", id: "agent-1" }],
  branch: "feat/envelope",
  pr: "https://github.com/org/repo/pull/1",
  blockedBy: "task.0008",
  updatedAt: "2026-10-20T00:00:00.000Z",
  createdAt: "2026-10-18T00:00:00.000Z",
  deployVerified: true,
};

function capabilityReturning(
  items: readonly WorkItemInfo[]
): WorkItemCapability {
  return {
    query: vi.fn().mockResolvedValue(items),
    transitionStatus: vi.fn(),
    patch: vi.fn(),
  };
}

describe("work-item tool envelope conformance (bug.5552)", () => {
  const impl = createWorkItemQueryImplementation({
    workItemCapability: capabilityReturning([ITEM]),
  });

  it("the tool output conforms to the pinned WorkItemDto subset (list path)", async () => {
    const out = await impl.execute({ statuses: ["needs_implement"] });
    const item = out.items[0];
    expect(item).toBeDefined();
    // Throws if any of the 14 pinned fields is missing or mistyped.
    expect(() => EnvelopeSchema.parse(item)).not.toThrow();
  });

  it("the by-ids path returns the same envelope key-set as the list path", async () => {
    const list = await impl.execute({ statuses: ["needs_implement"] });
    const byId = await impl.execute({ ids: ["task.0007"] });
    const pinnedKeys = (o: Record<string, unknown>) =>
      Object.keys(ENVELOPE_FIELDS)
        .filter((k) => o[k] !== undefined)
        .sort();
    expect(pinnedKeys(byId.items[0] as Record<string, unknown>)).toEqual(
      pinnedKeys(list.items[0] as Record<string, unknown>)
    );
  });

  it("fails the oracle when a pinned field drifts (createdAt dropped)", () => {
    const { createdAt: _dropped, ...withoutCreatedAt } = ITEM;
    expect(() => EnvelopeSchema.parse(withoutCreatedAt)).toThrow();
  });

  it("fails the oracle when a pinned field is mistyped (deployVerified)", () => {
    expect(() =>
      EnvelopeSchema.parse({ ...ITEM, deployVerified: "yes" })
    ).toThrow();
  });
});
