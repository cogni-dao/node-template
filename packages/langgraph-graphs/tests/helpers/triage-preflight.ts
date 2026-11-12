// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import type { ToolExecFn } from "../../src/inproc/types";

/** Real contracts and complete no-work prerequisites for native program tests. */
export const triageReadContracts = CORE_TOOL_BUNDLE.filter((tool) =>
  ["core__knowledge_read", "core__goal_list", "core__goal_progress"].includes(
    tool.contract.name,
  ),
).map((tool) => tool.contract);

export const emptyTriageRead: ToolExecFn = async (name, input) => {
  if (name === "core__knowledge_read")
    return {
      ok: true,
      value: {
        mode: "get",
        entries: [
          {
            id: (input as { id: string }).id,
            content: "Complete fixture guidance.",
          },
        ],
        totalFound: 1,
      },
    };
  if (name === "core__goal_list") return { ok: true, value: { goals: [] } };
  if (name === "core__goal_progress")
    return {
      ok: true,
      value: {
        goals: [],
        asOf: "2026-11-12T00:00:00.000Z",
        environment: "local",
        historyMode: "none",
        unbound: [],
        orphans: [],
      },
    };
  return { ok: true, value: {} };
};
