// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/schedule-manage`
 * Purpose: Prove create maps flat instruction and purpose fields into the stored job input.
 * Scope: Unit — fake ScheduleCapability.
 * Invariants: PURPOSE_IN_META, CREATE_ONLY_FIELDS.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import { createScheduleManageImplementation } from "../src/tools/schedule-manage";

function setup() {
  const create = vi.fn(async (input: { graphId: string }) => ({ id: "s1", graphId: input.graphId }));
  const capability = { create, update: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(), list: vi.fn() };
  const tool = createScheduleManageImplementation({ scheduleCapability: capability as never });
  return { tool, create, capability };
}

describe("core__schedule_manage", () => {
  it("stores the instruction as one user message and the purpose in input._meta", async () => {
    const { tool, create } = setup();
    await tool.execute({
      action: "create",
      graphId: "langgraph:work-prioritizer",
      cron: "0 * * * *",
      timezone: "UTC",
      instruction: "Triage open work.",
      purpose: "node-work-triage",
    });
    expect(create).toHaveBeenCalledWith({
      graphId: "langgraph:work-prioritizer",
      cron: "0 * * * *",
      timezone: "UTC",
      input: {
        messages: [{ role: "user", content: "Triage open work." }],
        _meta: { purpose: "node-work-triage" },
      },
    });
  });

  it("refuses create-only fields on other actions", async () => {
    const { tool, capability } = setup();
    await expect(
      tool.execute({ action: "disable", scheduleId: "s1", purpose: "x" }),
    ).rejects.toThrow("create-only");
    expect(capability.setEnabled).not.toHaveBeenCalled();
  });
});
