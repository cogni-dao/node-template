// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/program`
 * Purpose: Configure the shared evidence factory for read-only mission proposals.
 * Scope: Guidance IDs, schemas and evidence validation; no work-item writes.
 * Invariants: Approved goals and observed revisions; unchanged scores yield no proposal.
 * Side-effects: none
 * Links: task.5333, expertise-role-contract, evidence-verification/graph.ts
 * @internal
 */
import { GOAL_LIST_NAME, WORK_ITEM_QUERY_NAME } from "@cogni/ai-tools";
import { z } from "zod";
import type { EvidenceProgram } from "../evidence-verification/graph";
import { WORK_PRIORITIZER_TOOL_IDS } from "./tools";

const Score = z
  .object({
    v: z.number().int().min(0).max(5),
    evidence: z.string().min(1).max(1000),
  })
  .strict();
const Payload = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string(),
            expectedRevision: z.number().int().nonnegative(),
            goalId: z.string(),
            rationale: z.string().min(1).max(2000),
            scores: z
              .object({
                goal: Score,
                time: Score,
                unblocks: Score,
                ease: Score,
                confidence: Score,
                agent: Score,
              })
              .strict(),
          })
          .strict()
      )
      .max(5),
  })
  .strict();

/** Program policy is code-owned, not an instruction found in a backlog item. */
export const MISSION_EVIDENCE_PROGRAM: EvidenceProgram = {
  id: "mission-prioritization",
  version: "1",
  requiredSources: [
    { id: "mission-loop-expert", kind: "skill" },
    { id: "dao-goals-design", kind: "reference" },
  ],
  readToolIds: WORK_PRIORITIZER_TOOL_IDS,
  initialReads: [{ tool: GOAL_LIST_NAME, args: {} }],
  assignment:
    "Read approved goals and current work items. Propose at most five justified six-axis score assessments, or a supported no-change result. This pilot is strictly read-only. Never write work items, goals or EDO. Investigate the current backlog with core__work_item_query. All six score axes are independent; 0 means unknown. A task title or stated goal does not establish urgency, dependency, verified confidence or autonomy. Work query summaries/outcomes are bounded excerpts, not full evidence of their claims.",
  criteria:
    "Check every item and revision against primary work-item reads, goal against approved goal IDs, each score against specific support. Scores >=4 require direct relevant evidence, not merely a URL or repeated generic goal. Human/credential/judgment gates force agent 1-2. Reject unsupported high scores, invented urgency, stale revisions and repeated unchanged score proposals. No-change must follow actual reads. This result is a proposal, never an effect receipt.",
  payloadSchema: Payload,
  payloadDescription:
    "{items:[{id:string,expectedRevision:number,goalId:string,rationale:string,scores:{goal:{v:0..5,evidence:string},time:{v:0..5,evidence:string},unblocks:{v:0..5,evidence:string},ease:{v:0..5,evidence:string},confidence:{v:0..5,evidence:string},agent:{v:0..5,evidence:string}}}]} (empty items for no_change)",
  initialEvidenceError(evidence) {
    const value = evidence.find((e) => e.tool === GOAL_LIST_NAME)?.value as
      | { goals?: unknown }
      | undefined;
    if (!Array.isArray(value?.goals)) return "goals_unavailable";
  },
  noOp(evidence) {
    const goals = evidence.find((e) => e.tool === GOAL_LIST_NAME)?.value as
      | { goals?: unknown[] }
      | undefined;
    if (Array.isArray(goals?.goals) && goals.goals.length === 0)
      return "no_approved_goals";
  },
  validate(payload, evidence, kind) {
    const p = Payload.parse(payload);
    if (kind === "no_change" && p.items.length)
      return "no_change_has_proposals";
    if (kind === "proposal" && !p.items.length) return "empty_proposal";
    const goals = evidence.find((e) => e.tool === GOAL_LIST_NAME)?.value as
      | { goals?: { id: string }[] }
      | undefined;
    if (!Array.isArray(goals?.goals)) return "goals_unavailable";
    const items = evidence
      .filter((e) => e.tool === WORK_ITEM_QUERY_NAME)
      .flatMap((e) => {
        const v = e.value as { items?: Record<string, unknown>[] };
        return Array.isArray(v.items) ? v.items : [];
      });
    for (const proposed of p.items) {
      if (!goals.goals.some((g) => g.id === proposed.goalId))
        return "unknown_goal";
      const current = items.find(
        (i) => i.id === proposed.id && i.revision === proposed.expectedRevision
      );
      if (!current) return "item_or_revision_unread";
      const old = current.scores as Record<string, { v?: unknown }> | undefined;
      if (
        old &&
        Object.entries(proposed.scores).every(
          ([axis, score]) => old[axis]?.v === score.v
        )
      )
        return "unchanged_score_proposal";
    }
    if (!evidence.some((e) => e.tool === WORK_ITEM_QUERY_NAME))
      return "work_items_unread";
  },
};
