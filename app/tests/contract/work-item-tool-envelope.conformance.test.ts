// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/work-item-tool-envelope.conformance`
 * Purpose: Check the derived tool envelope against the complete HTTP read contract.
 * Scope: Ordinary execution and wire compatibility checks.
 * Invariants: real revision, complete canonical context, additive legacy assignee id.
 * Side-effects: none
 * @internal
 */
import {
  createWorkItemQueryImplementation, createWorkItemReadImplementation, workItemReadContract,
  type WorkItemCapability, type WorkItemInfo,
  WorkItemOutputSchema, WorkItemQueryOutputSchema,
  KnowledgeReadOutputSchema, KnowledgeSearchOutputSchema,
} from "@cogni/ai-tools";
import { KnowledgeRowSchema } from "@cogni/knowledge-store/contracts";
import { WorkItemDtoSchema } from "@cogni/work-items";
import { describe, expect, it, vi } from "vitest";

const item: WorkItemInfo = {
  id: "task.0007", type: "task", title: "Read context", status: "needs_implement",
  revision: 7, node: "shared", labels: ["proof"], specRefs: ["knowledge:context"],
  assignees: [{ kind: "agent", agentId: "agent-1" }], externalRefs: [],
  reviewer: "independent", claimedByRun: "run-1", claimedAt: "2026-10-20T00:00:00Z", lastCommand: "implement",
  createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", deployVerified: true,
};
const capability: WorkItemCapability = { query: vi.fn().mockResolvedValue([item]), transitionStatus: vi.fn(), patch: vi.fn() };

/**
 * Rule 3 (agent-tool-context-envelope): exhaustion minus a tiny, reviewed exclusion set, never a
 * static allowlist. A key added to the wire DTO fails here until the tool carries it or someone
 * names it in EXCLUDED with a reason.
 */
const EXCLUDED_FROM_TOOL = new Set<string>([]);
const missing = (wire: { shape: object }, tool: { shape: object }) =>
  Object.keys(wire.shape).filter(
    (key) => !EXCLUDED_FROM_TOOL.has(key) && !(key in tool.shape),
  );

describe("exhaustive-minus-exclusion guard (task.0118)", () => {
  it("the read and query tool items carry every wire key, including nested moves", () => {
    expect(missing(WorkItemDtoSchema, WorkItemOutputSchema)).toEqual([]);
    expect(missing(WorkItemDtoSchema.shape.moves.unwrap().element, WorkItemOutputSchema.shape.moves.unwrap().element)).toEqual([]);
    expect(missing(WorkItemDtoSchema, workItemReadContract.outputSchema.shape.item.unwrap())).toEqual([]);
    expect(missing(WorkItemOutputSchema, WorkItemDtoSchema)).toEqual(["sourceUrl", "sourceUrlUnavailable"]);
    // The chain and links this task added are on the one schema, so the guard covers them.
    expect(Object.keys(WorkItemDtoSchema.shape)).toContain("links");
    expect(Object.keys(WorkItemDtoSchema.shape.moves.unwrap().element.shape)).toEqual(
      expect.arrayContaining(["metric", "kpi", "goal", "context"]),
    );
  });
  it("a read carries the chain and links through the tool unchanged", async () => {
    const chainItem: WorkItemInfo = {
      ...item,
      moves: [
        {
          metricId: "work-open",
          direction: "up",
          baselineObservationId: null,
          metric: { id: "work-open", title: "Open work", unit: "items", display: "volume" },
          kpi: { metricId: "work-validated", title: "Validated work", comparator: "gte", target: { value: 10, unit: "items" }, status: "behind" },
          goal: { id: "goal-ai-work-converges", title: "AI work converges" },
        },
        { metricId: "gone", direction: "down", baselineObservationId: null, context: "unavailable" },
      ],
      links: { items: [], nextCursor: "c1" },
    };
    const read = vi.fn().mockResolvedValue(chainItem);
    const reader = createWorkItemReadImplementation({
      workItemCapability: { query: vi.fn(), read, transitionStatus: vi.fn(), patch: vi.fn() },
    });
    const result = workItemReadContract.outputSchema.parse(await reader.execute({ id: item.id, includeLinks: true }));
    expect(read).toHaveBeenCalledWith(item.id, { includeLinks: true });
    expect(WorkItemDtoSchema.parse(result.item)).toMatchObject({ moves: chainItem.moves, links: chainItem.links });
  });
});

describe("derived work-item read envelope", () => {
  it("retains every canonical work-item and knowledge schema key", () => {
    expect(Object.keys(WorkItemOutputSchema.shape)).toEqual(
      expect.arrayContaining(Object.keys(WorkItemDtoSchema.shape))
    );
    expect(Object.keys(KnowledgeReadOutputSchema.shape.entries.element.shape)).toEqual(
      expect.arrayContaining(Object.keys(KnowledgeRowSchema.shape))
    );
    expect(Object.keys(KnowledgeSearchOutputSchema.shape.results.element.shape)).toEqual(
      expect.arrayContaining(Object.keys(KnowledgeRowSchema.shape))
    );
  });
  it("derives all HTTP item fields and adds only tool provenance", async () => {
    const execute = createWorkItemQueryImplementation({ workItemCapability: capability }).execute;
    for (const params of [{}, { ids: [item.id] }]) {
      const result = WorkItemQueryOutputSchema.parse(await execute(params));
      expect(WorkItemDtoSchema.parse(result.items[0])).toMatchObject(item);
      expect(result.items[0]?.assignees[0]).toEqual({ kind: "agent", agentId: "agent-1", id: "agent-1" });
    }
  });
  it("rejects missing revision instead of inventing one", async () => {
    const { revision: _revision, ...missingRevision } = item;
    expect(WorkItemDtoSchema.safeParse(missingRevision).success).toBe(false);
    expect(WorkItemOutputSchema.safeParse(missingRevision).success).toBe(false);
  });
});
