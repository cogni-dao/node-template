import { describe, expect, it } from "vitest";

import {
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
