// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/langgraph-graphs/tests/graphs/coordinator-step-budget`
 * Purpose: A coordinating tick that hits the step limit ends in a report of its actual schedule writes.
 */

import { describe, expect, it } from "vitest";
import { createCoordinatorRunHooks } from "../../src/graphs/coordinator/graph";

describe("node operator step budget", () => {
  it("reports only successful schedule writes", () => {
    const hooks = createCoordinatorRunHooks();
    hooks.observeTool(
      "core__schedule_manage",
      { action: "enable", scheduleId: "s1" },
      { ok: true, value: { success: true, action: "enable", scheduleId: "s1", message: "ok" } },
    );
    hooks.observeTool("core__schedule_manage", { action: "create" }, { ok: false });
    const report = hooks.projectStepBudget();
    expect(report.answer).toContain("STEP_BUDGET");
    expect(report.answer).toContain("enable s1");
    expect(report.output).toEqual({
      telemetry: { aborted: true, abortReason: "step_budget", scheduleChanges: ["enable s1"] },
    });
  });

  it("says none when the tick changed nothing", () => {
    expect(createCoordinatorRunHooks().projectStepBudget().answer).toContain(
      "Schedule changes: none",
    );
  });
});
