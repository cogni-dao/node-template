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
  WorkItemQueryOutputSchema,
} from "@cogni/ai-tools";
import { WorkItemDtoSchema, type WorkItemDto } from "@cogni/node-contracts";
import { describe, expect, it, vi } from "vitest";

/**
 * Field-drift guard (bug.0003). The tool and the wire DTO are hand-written in
 * different packages/zod majors, so a new `WorkItem` field does NOT propagate by
 * construction. This guard makes that failure LOUD instead of silent: every field
 * on the wire `WorkItemDtoSchema` must be carried by the tool envelope, EXCEPT a
 * small, reviewed, named exclusion set. Add a field to the DTO and this test fails
 * until the tool carries it or it is consciously excluded here — killing the exact
 * silent-drift class that bug.5552 was (createdAt/deployVerified had been dropped).
 *
 * This is the enforceable half of the `agent-tool-context-envelope` standard rule 3
 * (exhaustion-minus-exclusion, never a static allowlist).
 */
const DTO_FIELDS_OMITTED_BY_TOOL = new Set<string>([
  // Routing/attribution/lifecycle fields a planner does not reason over. Each
  // addition here is a conscious decision, reviewed in the diff.
  "node",
  "externalRefs",
  "reviewer",
  "claimedByRun",
  "claimedAt",
  "lastCommand",
]);

/** Wire DTO fields the tool must carry = all DTO fields minus the exclusion set. */
function dtoFieldsMissingFromTool(
  dtoKeys: readonly string[],
  toolKeys: ReadonlySet<string>,
  excluded: ReadonlySet<string>
): string[] {
  return dtoKeys.filter((k) => !excluded.has(k) && !toolKeys.has(k)).sort();
}

const WIRE_DTO_KEYS = Object.keys(WorkItemDtoSchema.shape);
// Tool output item schema: WorkItemQueryOutputSchema.shape.items is a ZodArray.
const TOOL_ITEM_KEYS = new Set(
  Object.keys(
    (
      WorkItemQueryOutputSchema.shape.items as unknown as {
        element: { shape: Record<string, unknown> };
      }
    ).element.shape
  )
);

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

describe("work-item envelope field-drift guard (bug.0003)", () => {
  it("the tool carries every wire-DTO field except the reviewed exclusion set", () => {
    const missing = dtoFieldsMissingFromTool(
      WIRE_DTO_KEYS,
      TOOL_ITEM_KEYS,
      DTO_FIELDS_OMITTED_BY_TOOL
    );
    // If this fails, a WorkItemDtoSchema field is neither carried by
    // core__work_item_query nor listed in DTO_FIELDS_OMITTED_BY_TOOL. Add it to
    // the tool envelope (capabilities/work-item.ts + work-item-query.ts) or, if a
    // planner genuinely should not see it, add it to the exclusion set above.
    expect(missing).toEqual([]);
  });

  it("every exclusion is a real wire-DTO field (no stale entries)", () => {
    const stale = [...DTO_FIELDS_OMITTED_BY_TOOL].filter(
      (k) => !WIRE_DTO_KEYS.includes(k)
    );
    expect(stale).toEqual([]);
  });

  it("FAILS LOUD when a new wire-DTO field is added and not handled (proof)", () => {
    // Simulate a future field on the DTO; the guard must flag it so CI blocks a
    // silent drift. This is the property bug.5552 lacked.
    const withNewField = [...WIRE_DTO_KEYS, "severity"];
    expect(
      dtoFieldsMissingFromTool(
        withNewField,
        TOOL_ITEM_KEYS,
        DTO_FIELDS_OMITTED_BY_TOOL
      )
    ).toEqual(["severity"]);
  });
});
