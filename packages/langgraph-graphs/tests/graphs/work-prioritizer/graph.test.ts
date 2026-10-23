// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import {
  EDO_DECIDE_NAME,
  GOAL_LIST_NAME,
  goalListContract,
  KNOWLEDGE_READ_NAME,
  knowledgeReadContract,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_TRANSITION_NAME,
  workItemQueryContract,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import { LANGGRAPH_CATALOG } from "../../../src/catalog";
import type { EvidenceReceipt } from "../../../src/graphs/evidence-verification/graph";
import { createWorkPrioritizerGraph } from "../../../src/graphs/work-prioritizer/graph";
import { MISSION_EVIDENCE_PROGRAM } from "../../../src/graphs/work-prioritizer/program";
import { WORK_PRIORITIZER_TOOL_IDS } from "../../../src/graphs/work-prioritizer/tools";
import { createInProcGraphRunner } from "../../../src/inproc/runner";

describe("read-only mission program", () => {
  it("exposes no business write tools and retains its compatibility ID", () => {
    const entry = LANGGRAPH_CATALOG["work-prioritizer"];
    expect(entry?.graphFactory).toBe(createWorkPrioritizerGraph);
    expect(entry?.finalOnly).toBe(true);
    expect(WORK_PRIORITIZER_TOOL_IDS).not.toContain(WORK_ITEM_TRANSITION_NAME);
    expect(WORK_PRIORITIZER_TOOL_IDS).not.toContain(EDO_DECIDE_NAME);
    expect(WORK_PRIORITIZER_TOOL_IDS).toContain(KNOWLEDGE_READ_NAME);
  });

  it("a genuine empty goal read returns no-op without a model or business write", async () => {
    const executed: string[] = [];
    const { stream, final } = createInProcGraphRunner({
      createGraph: createWorkPrioritizerGraph,
      completionFn: () => {
        throw new Error("no model should run without goals");
      },
      toolContracts: [
        goalListContract,
        knowledgeReadContract,
        workItemQueryContract,
      ],
      createToolExecFn: () => async (name, args) => {
        executed.push(name);
        if (name === GOAL_LIST_NAME) return { ok: true, value: { goals: [] } };
        const id = (args as { id: string }).id;
        return {
          ok: true,
          value: {
            mode: "get",
            totalFound: 1,
            entries: [
              {
                id,
                content: "A goal must be approved. No goals means no ranking.",
                sourceRef: "test:1",
                entryType: id === "mission-loop-expert" ? "skill" : "reference",
                tags: ["expertise-role"],
              },
            ],
          },
        };
      },
      request: {
        runId: "mission-1",
        nodeId: "node-1",
        messages: [{ role: "user", content: "Prioritize" }],
        configurable: {
          model: "existing-model",
          toolIds: [...WORK_PRIORITIZER_TOOL_IDS],
        },
      },
    });
    for await (const _ of stream) {
      /* drain normal billing path */
    }
    expect((await final).structuredOutput).toMatchObject({
      status: "no_op",
      reason: "no_approved_goals",
      budget: { modelCalls: 0 },
      telemetry: { changeCount: 0 },
    });
    expect(executed).toEqual([
      KNOWLEDGE_READ_NAME,
      KNOWLEDGE_READ_NAME,
      GOAL_LIST_NAME,
    ]);
  });

  const scores = Object.fromEntries(
    ["goal", "time", "unblocks", "ease", "confidence", "agent"].map((key) => [
      key,
      { v: 3, evidence: "observed" },
    ])
  );
  const evidence: EvidenceReceipt[] = [
    {
      id: "e1",
      tool: GOAL_LIST_NAME,
      args: {},
      sha256: "hash",
      value: { goals: [{ id: "goal-1" }] },
    },
    {
      id: "e2",
      tool: WORK_ITEM_QUERY_NAME,
      args: {},
      sha256: "hash",
      value: { items: [{ id: "task.1", revision: 4, scores }] },
    },
  ];
  const payload = {
    items: [
      {
        id: "task.1",
        expectedRevision: 4,
        goalId: "goal-1",
        rationale: "facts",
        scores,
      },
    ],
  };

  it("rejects unchanged score churn independently of revision and model claims", () => {
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(payload, evidence, "proposal")
    ).toBe("unchanged_score_proposal");
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.({ items: [] }, evidence, "no_change")
    ).toBeUndefined();
  });

  it("rejects invented goals and unread/stale item revisions", () => {
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        { items: [{ ...payload.items[0], goalId: "invented" }] },
        evidence,
        "proposal"
      )
    ).toBe("unknown_goal");
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        { items: [{ ...payload.items[0], expectedRevision: 3 }] },
        evidence,
        "proposal"
      )
    ).toBe("item_or_revision_unread");
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        { items: [] },
        evidence.slice(0, 1),
        "no_change"
      )
    ).toBe("work_items_unread");
  });
});
