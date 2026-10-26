// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import {
  createWorkItemQueryImplementation,
  EDO_DECIDE_NAME,
  GOAL_LIST_NAME,
  goalListContract,
  KNOWLEDGE_READ_NAME,
  knowledgeReadContract,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_TRANSITION_NAME,
  workItemQueryContract,
} from "@cogni/ai-tools";
import { parseWorkItemScores, type WorkItemScores } from "@cogni/work-items";
import { describe, expect, it } from "vitest";
import { LANGGRAPH_CATALOG } from "../../../src/catalog";
import {
  createEvidenceVerificationGraph,
  type EvidenceReceipt,
} from "../../../src/graphs/evidence-verification/graph";
import { createWorkPrioritizerGraph } from "../../../src/graphs/work-prioritizer/graph";
import { MISSION_EVIDENCE_PROGRAM } from "../../../src/graphs/work-prioritizer/program";
import { MISSION_SCORE_RUBRIC } from "../../../src/graphs/work-prioritizer/rubric";
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
      { v: 3 },
    ])
  );
  const support = Object.fromEntries(
    Object.keys(scores).map((axis) => [
      axis,
      {
        rationale: "Observed independent facts",
        evidenceIds: ["e1"],
      },
    ])
  );
  const source = "https://independent.example/evidence";
  const self = "https://node.example/work/items/task.1";
  const evidence: [EvidenceReceipt, EvidenceReceipt] = [
    {
      id: "e1",
      tool: GOAL_LIST_NAME,
      args: {},
      sha256: "hash",
      value: {
        goals: [
          {
            id: "goal-1",
            sourceUrl: source,
            content: "Independent measurement",
          },
        ],
      },
    },
    {
      id: "e2",
      tool: WORK_ITEM_QUERY_NAME,
      args: {},
      sha256: "hash",
      value: {
        items: [{ id: "task.1", revision: 4, scores, sourceUrl: self }],
      },
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
        support,
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

  const proposed = (changes: Record<string, unknown>) => ({
    items: [{ ...payload.items[0], ...changes }],
  });
  const current = (
    stored: unknown,
    extras: Record<string, unknown> = {}
  ): EvidenceReceipt[] => [
    evidence[0],
    {
      ...evidence[1],
      value: {
        items: [
          {
            id: "task.1",
            revision: 4,
            scores: stored,
            sourceUrl: self,
            ...extras,
          },
        ],
      },
    },
  ];

  it.each([
    { ...scores, goal: { v: 4 } },
    { ...scores, goal: { v: 4, evidence: "not the canonical wire contract" } },
    { ...scores, goal: { v: 4, ev: "http://unsafe.example" } },
    { ...scores, goal: { v: 4, ev: "https://user:password@example.org" } },
    { ...scores, goal: { v: 6 } },
    Object.fromEntries(
      Object.keys(scores).map((axis) => [
        axis,
        { v: 4, ev: `https://example.org/${"x".repeat(200)}` },
      ])
    ),
    { goal: { v: 0 } },
  ])("delegates malformed canonical score objects and six-axis completeness to schema rejection", (invalid) => {
    expect(
      MISSION_EVIDENCE_PROGRAM.payloadSchema.safeParse(
        proposed({ scores: invalid })
      ).success
    ).toBe(false);
  });

  it("accepts unknown zero and rejects mutation fields in proposals", () => {
    const p = proposed({ scores: { ...scores, goal: { v: 0 } } });
    expect(MISSION_EVIDENCE_PROGRAM.payloadSchema.safeParse(p).success).toBe(
      true
    );
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(p, evidence, "proposal")
    ).toBeUndefined();
    expect(
      MISSION_EVIDENCE_PROGRAM.payloadSchema.safeParse(
        proposed({ priority: 0 })
      ).success
    ).toBe(false);
    expect(
      MISSION_EVIDENCE_PROGRAM.payloadSchema.safeParse(proposed({ rank: 1 }))
        .success
    ).toBe(false);
  });

  it("allows evidence-only refresh from an actually-read external source, while unchanged v+ev is no-op", () => {
    const next = { ...scores, goal: { v: 3, ev: source } };
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: next }),
        evidence,
        "proposal"
      )
    ).toBeUndefined();
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: next }),
        current(next),
        "proposal"
      )
    ).toBe("unchanged_score_proposal");
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({
          expectedRevision: 5,
          scores: Object.fromEntries(Object.entries(next).reverse()),
          rationale: "Different prose",
        }),
        current(next, { revision: 5 }),
        "proposal"
      )
    ).toBe("unchanged_score_proposal");
  });

  it.each([
    "https://unread.example/facts",
    self,
  ])("rejects unread or self justification %s", (ev) => {
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: { ...scores, goal: { v: 4, ev } } }),
        evidence,
        "proposal"
      )
    ).toBe("justification_not_independently_read");
  });

  it("rejects missing per-axis receipts and unavailable source provenance", () => {
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({
          support: {
            ...support,
            goal: { rationale: "claim", evidenceIds: ["invented"] },
          },
        }),
        evidence,
        "proposal"
      )
    ).toBe("unsupported_axis_evidence");
    const unavailable = [
      {
        ...evidence[0],
        value: {
          goals: [
            { id: "goal-1", sourceUrl: source, sourceUrlUnavailable: true },
          ],
        },
      },
      evidence[1],
    ];
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: { ...scores, goal: { v: 4, ev: source } } }),
        unavailable,
        "proposal"
      )
    ).toBe("justification_not_independently_read");
  });

  it("preserves extra stored axes exactly and rejects deletion, edits or invention", () => {
    const stored = {
      ...scores,
      risk: { v: 4, ev: "https://historical.example/unchanged" },
    };
    const changed = { ...stored, goal: { v: 0 } };
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: changed }),
        current(stored),
        "proposal"
      )
    ).toBeUndefined();
    for (const next of [
      { ...scores, goal: { v: 0 } },
      { ...changed, risk: { v: 3 } },
      { ...changed, risk: { v: 4, ev: "https://historical.example/changed" } },
      { ...changed, invented: { v: 0 } },
    ]) {
      expect(
        MISSION_EVIDENCE_PROGRAM.validate?.(
          proposed({ scores: next }),
          current(stored),
          "proposal"
        )
      ).toBe("extra_axes_not_preserved");
    }
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: changed }),
        current(stored, { scoresTruncated: true }),
        "proposal"
      )
    ).toBe("current_scores_incomplete_or_invalid");
  });

  // Synthetic replay of the returned v2 author defect; no model-quality claim.
  const unknownPayload = proposed({
    scores: { ...scores, confidence: { v: 0 } },
    support: {
      ...support,
      confidence: {
        rationale:
          "Inspected e2; no live validation proof supplied, so confidence is unknown",
        evidenceIds: ["e2"],
      },
    },
  });
  const unknownProposal = (p: unknown) =>
    JSON.stringify({
      kind: "proposal",
      summary: "Uncertainty is explicit",
      evidenceIds: ["e1", "e2"],
      payload: p,
    });
  const verdict = JSON.stringify({
    verdict: "accept",
    reason: "Observed uncertainty represented honestly",
  });
  async function assess(
    complete: (input: string, index: number) => string,
    work = evidence[1].value,
    noHumanTask = false
  ) {
    const calls: string[] = [];
    const reads: string[] = [];
    const runner = createInProcGraphRunner({
      createGraph: (opts) =>
        createEvidenceVerificationGraph(opts, {
          ...MISSION_EVIDENCE_PROGRAM,
          initialReads: [
            { tool: GOAL_LIST_NAME, args: {} },
            { tool: WORK_ITEM_QUERY_NAME, args: { ids: ["task.1"] } },
          ],
        }),
      completionFn: (req) => {
        const input = JSON.stringify(req.messages);
        const content = complete(input, calls.length);
        calls.push(input);
        return {
          stream: (async function* () {})(),
          final: Promise.resolve({ ok: true as const, content }),
        };
      },
      toolContracts: [
        knowledgeReadContract,
        goalListContract,
        workItemQueryContract,
      ],
      createToolExecFn: () => async (name, args) => {
        reads.push(name);
        if (name === GOAL_LIST_NAME)
          return { ok: true, value: evidence[0].value };
        if (name === WORK_ITEM_QUERY_NAME) return { ok: true, value: work };
        const id = (args as { id: string }).id;
        return {
          ok: true,
          value: {
            mode: "get",
            totalFound: 1,
            entries: [
              {
                id,
                content: "Unknown is zero. Sources must support the claim.",
                sourceRef: "test:1",
                entryType: id === "mission-loop-expert" ? "skill" : "reference",
                tags: ["expertise-role"],
              },
            ],
          },
        };
      },
      request: {
        runId: "schema-repair",
        nodeId: "node-1",
        messages: noHumanTask
          ? []
          : [{ role: "user", content: "Assess task.1" }],
        configurable: {
          model: "existing-model",
          toolIds: [...WORK_PRIORITIZER_TOOL_IDS],
        },
      },
    });
    for await (const _ of runner.stream) {
      /* preserve usage drain */
    }
    return { result: await runner.final, calls, reads };
  }

  it.each([
    { rejectAgain: false, noHumanTask: false },
    { rejectAgain: true, noHumanTask: false },
    { rejectAgain: false, noHumanTask: true },
    { rejectAgain: true, noHumanTask: true },
  ])("keeps independent verification (rejectAgain=$rejectAgain, noHumanTask=$noHumanTask)", async ({
    rejectAgain,
    noHumanTask,
  }) => {
    const unsupported = proposed({
      scores: { ...scores, confidence: { v: 0 } },
      support: {
        ...support,
        ease: {
          rationale:
            "The status implies two to three implementation iterations",
          evidenceIds: ["e2"],
        },
      },
    });
    const corrected = proposed({
      scores: { ...scores, ease: { v: 0 }, confidence: { v: 0 } },
      support: {
        ...support,
        ease: {
          rationale:
            "Inspected e2: a human check remains, but its effort is unspecified",
          evidenceIds: ["e2"],
        },
      },
    });
    const feedback =
      "task.1 ease: e2 requires human review but supplies no iteration count; status does not entail ease=3";
    const raw = unknownProposal(unsupported);
    const work = {
      items: [
        {
          id: "task.1",
          revision: 4,
          scores,
          sourceUrl: self,
          status: "needs_implement",
          summary:
            "A signed-in human must review the completed display; remaining effort is unspecified",
        },
      ],
    };
    const { result, calls } = await assess(
      (input, index) => {
        if (index === 0) return "e2: human review remains; effort unspecified";
        if (index === 1) return raw;
        if (index === 2)
          return JSON.stringify({ verdict: "revise", reason: feedback });
        if (index === 3) {
          const request = JSON.parse(JSON.parse(input).at(-1).content);
          expect(request.feedback).toBe(feedback);
          expect(request.rejectedArtifact).toBe(raw);
          expect(request.rejectedProposal.payload).toEqual(unsupported);
          return unknownProposal(rejectAgain ? unsupported : corrected);
        }
        return rejectAgain
          ? JSON.stringify({ verdict: "revise", reason: feedback })
          : verdict;
      },
      work,
      noHumanTask
    );
    expect(calls).toHaveLength(5);
    expect(result.structuredOutput).toMatchObject({
      status: rejectAgain ? "incomplete" : "accepted",
      revisions: 1,
    });
    if (rejectAgain)
      expect(result.structuredOutput).not.toHaveProperty("proposal");
    else
      expect(result.structuredOutput?.proposal).toMatchObject({
        payload: corrected,
      });
    const messages = calls.map(
      (call) => JSON.parse(call) as { role: string; content: string }[]
    );
    for (const stage of messages) {
      const input = JSON.parse(stage[1]?.content ?? "{}");
      if (noHumanTask) expect(input).not.toHaveProperty("task");
      else expect(input.task).toBe("Assess task.1");
      expect(stage[0]?.content).toContain(
        "Unknown is zero. Sources must support the claim."
      );
      expect(JSON.parse(stage[1]?.content ?? "{}").evidence[1].value).toEqual(
        work
      );
    }
    expect(messages[0]?.[0]?.content).not.toContain(
      MISSION_EVIDENCE_PROGRAM.assignment
    );
    expect(JSON.parse(messages[0]?.[1]?.content ?? "{}").programContext).toBe(
      MISSION_EVIDENCE_PROGRAM.assignment
    );
    expect(messages[1]?.[0]?.content).toContain(
      MISSION_EVIDENCE_PROGRAM.assignment
    );
    expect(messages[0]?.[0]?.content).not.toContain(MISSION_SCORE_RUBRIC);
    for (const index of [1, 2, 3, 4]) {
      expect(
        messages[index]?.[0]?.content.split(MISSION_SCORE_RUBRIC)
      ).toHaveLength(2);
    }
    for (const index of [2, 4]) {
      expect(messages[index]?.[0]?.content).toContain(
        MISSION_EVIDENCE_PROGRAM.criteria
      );
      expect(messages[index]?.[0]?.content).not.toContain(
        MISSION_EVIDENCE_PROGRAM.assignment
      );
      expect(
        JSON.parse(messages[index]?.[1]?.content ?? "{}")
      ).not.toHaveProperty("findings");
    }
  });

  it.each([
    false,
    true,
  ])("rejects duplicate proposal IDs before semantic verification (conflicting=%s)", async (conflicting) => {
    const item = {
      ...payload.items[0],
      scores: { ...scores, confidence: { v: 0 } },
    };
    const duplicate = {
      items: [
        item,
        conflicting
          ? { ...item, scores: { ...item.scores, goal: { v: 0 } } }
          : item,
      ],
    };
    // Both entries are individually valid; ambiguity is the cross-item defect.
    expect(
      MISSION_EVIDENCE_PROGRAM.payloadSchema.safeParse(duplicate).success
    ).toBe(true);
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(duplicate, evidence, "proposal")
    ).toBe("duplicate_proposal_id");
    const { result, calls } = await assess((input, index) => {
      if (index === 0) return "facts";
      if (input.includes("independent verifier")) return verdict;
      return unknownProposal(duplicate);
    });
    expect(result.structuredOutput).toMatchObject({
      status: "incomplete",
      reason: "duplicate_proposal_id",
      revisions: 1,
    });
    expect(calls).toHaveLength(3);
    expect(calls.some((input) => input.includes("independent verifier"))).toBe(
      false
    );
  });

  it("allows one duplicate-ID correction only after fresh semantic verification", async () => {
    const duplicate = {
      items: [unknownPayload.items[0], unknownPayload.items[0]],
    };
    const { result, calls } = await assess((input, index) => {
      if (index === 0) return "facts";
      if (index === 1) return unknownProposal(duplicate);
      if (index === 2) {
        expect(input).toContain("duplicate_proposal_id");
        return unknownProposal(unknownPayload);
      }
      expect(input).toContain("independent verifier");
      return verdict;
    });
    expect(result.structuredOutput).toMatchObject({
      status: "accepted",
      revisions: 1,
      proposal: { payload: unknownPayload },
    });
    expect(calls).toHaveLength(4);
  });

  it("repairs unknown representation using canonical issue paths and actual inspected receipts", async () => {
    const invalid = proposed({
      scores: { ...scores, confidence: {} },
      support: {
        ...support,
        confidence: { rationale: "Unknown", evidenceIds: [] },
      },
    });
    const raw = unknownProposal(invalid);
    const { result, calls, reads } = await assess((input, index) => {
      if (index === 0) return "facts";
      if (index === 1) return raw;
      if (index === 2) {
        const repair = JSON.parse(JSON.parse(input).at(-1).content);
        expect(repair.rejectedArtifact).toBe(raw);
        const issues = JSON.parse(repair.feedback).issues;
        expect(issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "invalid_value",
              path: ["payload", "items", 0, "scores", "confidence", "v"],
            }),
            expect.objectContaining({
              path: [
                "payload",
                "items",
                0,
                "support",
                "confidence",
                "evidenceIds",
              ],
            }),
          ])
        );
        return unknownProposal(unknownPayload);
      }
      expect(input).toContain("independent verifier");
      return verdict;
    });
    expect(result.structuredOutput).toMatchObject({
      program: { version: "3.2" },
      status: "accepted",
      revisions: 1,
      proposal: { payload: unknownPayload },
    });
    expect(calls).toHaveLength(4);
    expect(reads).toHaveLength(4);
    expect(
      MISSION_EVIDENCE_PROGRAM.payloadSchema.safeParse(invalid).success
    ).toBe(false);
    expect(
      MISSION_EVIDENCE_PROGRAM.payloadSchema.safeParse(unknownPayload).success
    ).toBe(true);
  });

  it.each([
    false,
    true,
  ])("self citations require a newly compliant model artifact (leftInvalid=%s)", async (leftInvalid) => {
    const selfCited = proposed({
      scores: { ...scores, goal: { v: 4, ev: self } },
    });
    const { result, calls } = await assess((input, index) => {
      if (index === 0) return "facts";
      if (index === 1) return unknownProposal(selfCited);
      if (index === 2) {
        const repair = JSON.parse(JSON.parse(input).at(-1).content);
        expect(repair.rejectedProposal.payload).toEqual(selfCited);
        expect(repair.feedback).toContain(
          "justification_not_independently_read"
        );
        return unknownProposal(leftInvalid ? selfCited : unknownPayload);
      }
      return verdict;
    });
    expect(result.structuredOutput?.status).toBe(
      leftInvalid ? "incomplete" : "accepted"
    );
    expect(result.structuredOutput?.revisions).toBe(1);
    expect(calls).toHaveLength(leftInvalid ? 3 : 4);
  });

  it("stops when shape repair leaves a self citation, without a second repair or verifier", async () => {
    const invalid = proposed({
      scores: { ...scores, confidence: {}, goal: { v: 4, ev: self } },
    });
    const fixedShape = proposed({
      scores: { ...scores, confidence: { v: 0 }, goal: { v: 4, ev: self } },
    });
    const { result, calls } = await assess(
      (_input, index) =>
        ["facts", unknownProposal(invalid), unknownProposal(fixedShape)][
          index
        ] ?? verdict
    );
    expect(result.structuredOutput).toMatchObject({
      status: "incomplete",
      reason: "justification_not_independently_read",
      revisions: 1,
    });
    expect(calls).toHaveLength(3);
  });

  it.each([
    true,
    false,
  ])("never repairs incomplete or invalid stored score evidence (truncated=%s)", async (truncated) => {
    const work = {
      items: [
        {
          id: "task.1",
          revision: 4,
          sourceUrl: self,
          scores: truncated ? scores : { broken: {} },
          ...(truncated ? { scoresTruncated: true } : {}),
        },
      ],
    };
    const { result, calls } = await assess(
      (_input, index) =>
        index === 0 ? "facts" : unknownProposal(unknownPayload),
      work
    );
    expect(result.structuredOutput).toMatchObject({
      status: "incomplete",
      reason: "current_scores_incomplete_or_invalid",
      revisions: 0,
    });
    expect(calls).toHaveLength(2);
  });

  async function queried(stored: WorkItemScores) {
    const tool = createWorkItemQueryImplementation({
      nodePublicOrigin: "https://node.example",
      workItemCapability: {
        query: async () => [
          {
            id: "task.1",
            type: "task",
            title: "target",
            status: "needs_implement",
            revision: 4,
            scores: stored,
            labels: [],
            assignees: [],
            updatedAt: "2026-10-23T00:00:00Z",
          },
        ],
        transitionStatus: async () => {
          throw new Error("write forbidden");
        },
        patch: async () => {
          throw new Error("write forbidden");
        },
      },
    });
    // Exercise real projection AND validator: unknown metadata must not be stripped.
    return workItemQueryContract.outputSchema.parse(await tool.execute({}));
  }

  it("rejects a legacy score object capped by the actual read tool, even when the result looks canonical", async () => {
    const stored = {
      ...scores,
      ...Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [`extra_${i}`, { v: 2 }])
      ),
    };
    const output = await queried(stored);
    expect(output.items[0]?.scoresTruncated).toBe(true);
    expect(parseWorkItemScores(output.items[0]?.scores).ok).toBe(true);
    const fromRead: EvidenceReceipt[] = [
      evidence[0],
      { ...evidence[1], value: output },
    ];
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: { ...output.items[0]?.scores, goal: { v: 0 } } }),
        fromRead,
        "proposal"
      )
    ).toBe("current_scores_incomplete_or_invalid");
  });

  it("preserves a canonical exact1024-byte complete score object through the actual read tool", async () => {
    const stored: WorkItemScores = {
      ...scores,
      risk: { v: 3, ev: `https://source.example/${"a".repeat(270)}` },
      cost: { v: 3, ev: `https://source.example/${"b".repeat(270)}` },
      quality: { v: 3, ev: "https://source.example/" },
    };
    const remaining = 1024 - Buffer.byteLength(JSON.stringify(stored), "utf8");
    const exact = {
      ...stored,
      quality: { v: 3, ev: `https://source.example/${"c".repeat(remaining)}` },
    };
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(1024);
    expect(parseWorkItemScores(exact).ok).toBe(true);
    const output = await queried(exact);
    expect(output.items[0]?.scoresTruncated).toBeUndefined();
    expect(output.items[0]?.scores).toEqual(exact);
    const fromRead: EvidenceReceipt[] = [
      evidence[0],
      { ...evidence[1], value: output },
    ];
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: { ...exact, goal: { v: 0 } } }),
        fromRead,
        "proposal"
      )
    ).toBeUndefined();
  });

  it("accepts supported high scores but a stored link alone does not establish a current read", () => {
    const high = { ...scores, goal: { v: 4, ev: source } };
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: high }),
        evidence,
        "proposal"
      )
    ).toBeUndefined();
    const oldLink = "https://historical.example/unread";
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: { ...scores, goal: { v: 4, ev: oldLink } } }),
        current({ ...scores, risk: { v: 3, ev: oldLink } }),
        "proposal"
      )
    ).toBe("extra_axes_not_preserved");
    const carried = {
      ...scores,
      risk: { v: 3, ev: oldLink },
      goal: { v: 4, ev: oldLink },
    };
    expect(
      MISSION_EVIDENCE_PROGRAM.validate?.(
        proposed({ scores: carried }),
        current({ ...scores, risk: { v: 3, ev: oldLink } }),
        "proposal"
      )
    ).toBe("justification_not_independently_read");
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
