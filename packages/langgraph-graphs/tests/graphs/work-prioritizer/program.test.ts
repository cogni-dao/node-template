// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The compiled work-review program offers the model exactly one write tool, the guarded update,
 * and its delegated children offer none (task.0065). Deterministic: a scripted completion records the
 * tool definitions each model call receives.
 */
import type { AiEvent } from "@cogni/ai-core";
import {
  EDO_DECIDE_NAME,
  EDO_HYPOTHESIZE_NAME,
  EDO_RECORD_OUTCOME_NAME,
  getCurrentTimeContract,
  knowledgeSearchContract,
  WORK_ITEM_UPDATE_NAME,
  workItemQueryContract,
  workItemReadContract,
  workItemUpdateContract,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import { LANGGRAPH_CATALOG } from "../../../src/catalog";
import { createMissionGraph } from "../../../src/graphs/mission/graph";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn, ToolExecFn } from "../../../src/inproc/types";
import {
  emptyTriageRead,
  triageReadContracts,
} from "../../helpers/triage-preflight";

const name = (tool: unknown): string => {
  const t = tool as { name?: string; function?: { name?: string } };
  return t.function?.name ?? t.name ?? "";
};

describe("work-review program tool surface", () => {
  it("offers only the guarded core__work_item_update to the root and no write tool to children", async () => {
    const entry = LANGGRAPH_CATALOG["work-prioritizer"];
    const offered: string[][] = [];
    const completionFn: CompletionFn = (req) => {
      const names = (req.tools ?? []).map(name);
      offered.push(names);
      const delegate = offered.length === 1;
      return {
        stream: (async function* (): AsyncIterable<AiEvent> {})(),
        final: Promise.resolve({
          ok: true as const,
          content: delegate ? "" : "done",
          ...(delegate && {
            toolCalls: [
              {
                id: "t1",
                type: "function" as const,
                function: {
                  name: "task",
                  arguments: JSON.stringify({
                    description: "read the ledger",
                    subagent_type: "ledger-reader",
                  }),
                },
              },
            ],
          }),
          finishReason: delegate ? "tool_calls" : "stop",
        }),
      };
    };
    const { stream, final } = createInProcGraphRunner({
      program: "work-review",
      sourceContext: {
        nodeId: "test-node",
        origin: "https://test.example",
        mission: { content: "Mission.", sourceRef: "test", buildSha: null },
      },
      createGraph: createMissionGraph,
      completionFn,
      createToolExecFn: (): ToolExecFn => emptyTriageRead,
      toolContracts: [
        ...triageReadContracts,
        knowledgeSearchContract,
        workItemQueryContract,
        workItemReadContract,
        workItemUpdateContract,
        getCurrentTimeContract,
      ],
      request: {
        runId: "surface",
        messages: [{ role: "user", content: "triage" }],
        configurable: { model: "test-model", toolIds: [...entry.toolIds] },
      },
    });
    for await (const _ of stream) {
      // drain
    }
    expect((await final).ok).toBe(true);

    const [root, child] = offered;
    expect(offered.length).toBeGreaterThanOrEqual(2);
    // Exactly one update tool reaches the root: the guarded one, not a second raw copy.
    expect(root?.filter((n) => n === WORK_ITEM_UPDATE_NAME)).toHaveLength(1);
    // The child is a leaf: reads only, no write, no further delegation.
    expect(child).not.toContain(WORK_ITEM_UPDATE_NAME);
    expect(child).not.toContain("task");
    expect(child).toContain("core__work_item_read");
  });

  it("exposes no EDO tool to the prioritizer", () => {
    const ids = LANGGRAPH_CATALOG["work-prioritizer"].toolIds;
    for (const id of [
      EDO_DECIDE_NAME,
      EDO_HYPOTHESIZE_NAME,
      EDO_RECORD_OUTCOME_NAME,
    ])
      expect(ids).not.toContain(id);
    expect(ids.filter((id) => id.startsWith("core__edo_"))).toEqual([]);
  });
});
