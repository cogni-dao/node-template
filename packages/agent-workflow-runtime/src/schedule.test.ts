import type { Client } from "@temporalio/client";
import { describe, expect, it } from "vitest";

import {
  deleteOrphanedWorkflowSchedules,
  workflowScheduleFingerprint,
  type DesiredWorkflowSchedule,
} from "./schedule.js";

function desired(input: Record<string, unknown>): DesiredWorkflowSchedule {
  return {
    id: "daily-poem",
    nodeId: "00000000-0000-4000-8000-000000000000",
    cron: "0 0 * * *",
    timezone: "UTC",
    workflowType: "ScheduledGraphWorkflow",
    taskQueue: "agent-workflows",
    input,
  };
}

describe("workflowScheduleFingerprint", () => {
  it("is stable across object key ordering", () => {
    expect(
      workflowScheduleFingerprint(desired({ b: 2, nested: { y: 2, x: 1 }, a: 1 }))
    ).toBe(
      workflowScheduleFingerprint(desired({ a: 1, nested: { x: 1, y: 2 }, b: 2 }))
    );
  });

  it("changes when the durable workflow contract changes", () => {
    expect(workflowScheduleFingerprint(desired({ graphId: "langgraph:poet" }))).not.toBe(
      workflowScheduleFingerprint(desired({ graphId: "langgraph:research" }))
    );
  });
});

describe("deleteOrphanedWorkflowSchedules", () => {
  it("deletes only this node's schedules absent from desired state", async () => {
    const deleted: string[] = [];
    const schedules = [
      "node-workflow:00000000-0000-4000-8000-000000000000:keep",
      "node-workflow:00000000-0000-4000-8000-000000000000:remove",
      "node-workflow:11111111-1111-4111-8111-111111111111:foreign",
    ];
    const client = {
      schedule: {
        async *list() {
          for (const scheduleId of schedules) yield { scheduleId };
        },
        getHandle(scheduleId: string) {
          return { delete: async () => void deleted.push(scheduleId) };
        },
      },
    } as unknown as Client;

    await expect(
      deleteOrphanedWorkflowSchedules(
        client,
        "00000000-0000-4000-8000-000000000000",
        ["keep"]
      )
    ).resolves.toEqual([
      "node-workflow:00000000-0000-4000-8000-000000000000:remove",
    ]);
    expect(deleted).toEqual([
      "node-workflow:00000000-0000-4000-8000-000000000000:remove",
    ]);
  });
});
