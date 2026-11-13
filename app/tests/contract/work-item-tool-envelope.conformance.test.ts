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
import { z } from "zod";

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

/** Peel optional, nullable and array wrappers down to the schema that holds keys (or a non-object). */
function inner(schema: unknown): { shape?: Record<string, unknown> } {
  let current = schema as { shape?: Record<string, unknown>; unwrap?: () => unknown; element?: unknown };
  for (let depth = 0; depth < 8; depth++) {
    if (current.shape) return current;
    if (typeof current.unwrap === "function") current = current.unwrap() as typeof current;
    else if (current.element) current = current.element as typeof current;
    else return current;
  }
  return current;
}

/** Every key path on the wire schema that the tool schema lacks, descending key by key into nested objects, arrays and optionals. */
function missingDeep(wire: unknown, tool: unknown, path = ""): string[] {
  const wireShape = inner(wire).shape;
  if (!wireShape) return [];
  const toolShape = inner(tool).shape ?? {};
  return Object.keys(wireShape).flatMap((key) => {
    const at = path ? `${path}.${key}` : key;
    if (EXCLUDED_FROM_TOOL.has(at)) return [];
    if (!(key in toolShape)) return [at];
    return missingDeep(wireShape[key], toolShape[key], at);
  });
}

describe("exhaustive-minus-exclusion guard (task.0118)", () => {
  it("the read and query tool items carry every wire key, compared key by key through moves, metric, kpi, goal and links", () => {
    expect(missingDeep(WorkItemDtoSchema, WorkItemOutputSchema)).toEqual([]);
    expect(missingDeep(WorkItemDtoSchema, workItemReadContract.outputSchema.shape.item)).toEqual([]);
    expect(missingDeep(WorkItemOutputSchema, WorkItemDtoSchema)).toEqual(["sourceUrl", "sourceUrlUnavailable"]);
    // The walker really descends: the sub-shapes this task added are on the path list.
    const paths = (schema: unknown, path = ""): string[] =>
      Object.entries(inner(schema).shape ?? {}).flatMap(([key, value]) => [
        `${path}${key}`,
        ...paths(value, `${path}${key}.`),
      ]);
    expect(paths(WorkItemDtoSchema)).toEqual(
      expect.arrayContaining([
        "moves.metric.title", "moves.metric.unit", "moves.metric.display",
        "moves.kpi.comparator", "moves.kpi.target.value", "moves.kpi.status",
        "moves.goal.id", "moves.context",
        "links.items.target.href", "links.items.label", "links.nextCursor", "links.unavailable",
      ]),
    );
  });
  it("mutation proof: a tool that drops one nested key fails the guard", () => {
    const kpi = WorkItemDtoSchema.shape.moves.unwrap().element.shape.kpi.unwrap();
    const dropped = WorkItemDtoSchema.extend({
      moves: z.array(WorkItemDtoSchema.shape.moves.unwrap().element.extend({ kpi: kpi.omit({ status: true }).optional() })).optional(),
      links: z.object({ items: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() }).optional(),
    });
    expect(missingDeep(WorkItemDtoSchema, dropped).sort()).toEqual(
      expect.arrayContaining([
        "moves.kpi.status",
        "links.unavailable",
        "links.items.direction",
        "links.items.target",
      ]),
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
