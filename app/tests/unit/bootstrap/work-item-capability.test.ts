// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-item-capability`
 * Purpose: The work-item capability pages a backlog read and projects the planner fields (story.5101).
 * Scope: createWorkItemCapability over in-memory ports. Does not touch a database.
 * Invariants: COMPLETE_SNAPSHOT — queryPage forwards `cursor` and returns the store's `nextCursor`.
 * Side-effects: none
 * Links: src/bootstrap/capabilities/work-item.ts, @cogni-dao/langgraph-graphs work-prioritizer
 * @internal
 */

import type {
  WorkItem,
  WorkItemCommandPort,
  WorkItemQueryPort,
  WorkQuery,
} from "@cogni/work-items";
import { describe, expect, it } from "vitest";

import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";

const item = (id: string): WorkItem =>
  ({
    id,
    type: "task",
    title: `Item ${id}`,
    status: "needs_implement",
    actor: "either",
    labels: [],
    assignees: [],
    specRefs: ["spec-a"],
    revision: 7,
    outcome: "done when x",
    estimate: 2,
    updatedAt: "2026-10-22T00:00:00.000Z",
  }) as unknown as WorkItem;

function capability(pages: Record<string, { ids: string[]; next?: string }>) {
  const seen: WorkQuery[] = [];
  const workItemQuery = {
    list: async (query?: WorkQuery) => {
      seen.push(query ?? {});
      const page = pages[query?.cursor ?? ""] ?? { ids: [] };
      return {
        items: page.ids.map(item),
        ...(page.next !== undefined && { nextCursor: page.next }),
      };
    },
  } as unknown as WorkItemQueryPort;
  const cap = createWorkItemCapability({
    workItemQuery,
    workItemCommand: {} as WorkItemCommandPort,
  });
  return { cap, seen };
}

describe("createWorkItemCapability", () => {
  it("queryPage forwards the cursor and returns nextCursor until the last page", async () => {
    const { cap, seen } = capability({
      "": { ids: ["task.1"], next: "c1" },
      c1: { ids: ["task.2"] },
    });
    if (!cap.queryPage) throw new Error("queryPage missing");

    const first = await cap.queryPage({ statuses: ["needs_implement"], limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual(["task.1"]);
    expect(first.nextCursor).toBe("c1");

    const last = await cap.queryPage({ limit: 1, cursor: "c1" });
    expect(last.items.map((i) => i.id)).toEqual(["task.2"]);
    expect(last.nextCursor).toBeUndefined();
    expect(seen[1]?.cursor).toBe("c1");
  });

  it("projects revision, outcome, estimate, and specRefs for planners", async () => {
    const { cap } = capability({ "": { ids: ["task.1"] } });
    const [info] = await cap.query({});
    expect(info).toMatchObject({
      revision: 7,
      outcome: "done when x",
      estimate: 2,
      specRefs: ["spec-a"],
    });
  });
});
