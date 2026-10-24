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
import {
  parseWorkItemScores,
  type WorkItemScore,
  type WorkItemScores,
} from "@cogni/work-items";
import { z } from "zod";
import type { EvidenceProgram } from "../evidence-verification/graph";
import { MISSION_SCORE_AXES, MISSION_SCORE_RUBRIC } from "./rubric";
import { WORK_PRIORITIZER_TOOL_IDS } from "./tools";

const Scores = z.custom<WorkItemScores>((value) => {
  const parsed = parseWorkItemScores(value);
  return (
    parsed.ok &&
    parsed.value !== null &&
    MISSION_SCORE_AXES.every((axis) => parsed.value?.[axis] !== undefined)
  );
}, "Expected canonical scores with all six mission axes");
const AxisSupport = z
  .object({
    rationale: z.string().min(1).max(1000),
    evidenceIds: z.array(z.string().min(1)).min(1).max(16),
  })
  .strict();
const Support = z
  .object({
    goal: AxisSupport,
    time: AxisSupport,
    unblocks: AxisSupport,
    ease: AxisSupport,
    confidence: AxisSupport,
    agent: AxisSupport,
  })
  .strict();
const sameScore = (
  a: WorkItemScore | undefined,
  b: WorkItemScore | undefined
): boolean => a?.v === b?.v && a?.ev === b?.ev;
const isAxis = (axis: string): boolean =>
  (MISSION_SCORE_AXES as readonly string[]).includes(axis);
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
            scores: Scores,
            support: Support,
          })
          .strict()
      )
      .max(5),
  })
  .strict();

/** Program policy is code-owned, not an instruction found in a backlog item. */
export const MISSION_EVIDENCE_PROGRAM: EvidenceProgram = {
  id: "mission-prioritization",
  version: "2",
  requiredSources: [
    { id: "mission-loop-expert", kind: "skill" },
    { id: "dao-goals-design", kind: "reference" },
  ],
  readToolIds: WORK_PRIORITIZER_TOOL_IDS,
  initialReads: [{ tool: GOAL_LIST_NAME, args: {} }],
  assignment: `Read approved goals and current work items. Propose at most five justified six-axis Evaluation assessments, or a supported no-change result. Evaluate every explicitly requested candidate when there are at most five, including poor goal fits; do not silently skip unsupported candidates. This pilot is strictly read-only. Never write work items, priority, rank, goals or EDO. Host write authorization remains separate from this pilot policy. Investigate the current backlog with core__work_item_query. Preserve every existing extra score axis unchanged in the proposed complete scores object; do not invent axes. Put explanations and receipt IDs in support, never inside scores. Work query summaries/outcomes are bounded excerpts, not full evidence of their claims. ${MISSION_SCORE_RUBRIC}`,
  criteria: `Check every item and revision against primary work-item reads, goal against approved goal IDs, each score against specific support. Check every requested candidate was assessed or explicitly identified as unsupported. URL membership only proves a read, not meaningful support: a generic goal does not establish urgency, dependencies, effort, confidence or autonomy. Missing source contents remain unknown or lower confidence. Reject unsupported high scores, invented urgency, stale revisions and unchanged score/evidence proposals. No-change must follow actual reads. This result is a proposal, never an effect receipt. ${MISSION_SCORE_RUBRIC}`,
  payloadSchema: Payload,
  payloadDescription:
    '{items:[{id:string,expectedRevision:number,goalId:string,rationale:string,scores:{goal:{v:0..5,ev?:"https URL"},time:{v,ev?},unblocks:{v,ev?},ease:{v,ev?},confidence:{v,ev?},agent:{v,ev?},...unchanged existing extra axes},support:{goal:{rationale:string,evidenceIds:string[]},time:{rationale,evidenceIds},unblocks:{rationale,evidenceIds},ease:{rationale,evidenceIds},confidence:{rationale,evidenceIds},agent:{rationale,evidenceIds}}}]} (empty items for no_change; scores must satisfy shared canonical validator)',
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
      const oldParsed = parseWorkItemScores(current.scores ?? null);
      if (current.scoresTruncated === true || !oldParsed.ok)
        return "current_scores_incomplete_or_invalid";
      const old = oldParsed.value ?? {};
      const extras = new Set(
        [...Object.keys(old), ...Object.keys(proposed.scores)].filter(
          (axis) => !isAxis(axis)
        )
      );
      if (
        [...extras].some((axis) => !sameScore(old[axis], proposed.scores[axis]))
      )
        return "extra_axes_not_preserved";
      for (const axis of MISSION_SCORE_AXES) {
        const cited = proposed.support[axis].evidenceIds.map((id) =>
          evidence.find((e) => e.id === id)
        );
        if (cited.some((receipt) => !receipt))
          return "unsupported_axis_evidence";
        const ev = proposed.scores[axis]?.ev;
        if (ev !== undefined) {
          // Only explicit tool provenance, never URLs found inside content or old score links.
          const read = cited.some((receipt) => {
            const value = receipt?.value as {
              goals?: Record<string, unknown>[];
              items?: Record<string, unknown>[];
            };
            const records =
              receipt?.tool === GOAL_LIST_NAME
                ? value.goals
                : receipt?.tool === WORK_ITEM_QUERY_NAME
                  ? value.items
                  : undefined;
            return (
              Array.isArray(records) &&
              records.some(
                (record) =>
                  record.sourceUrl === ev &&
                  record.sourceUrlUnavailable !== true &&
                  !(
                    receipt?.tool === WORK_ITEM_QUERY_NAME &&
                    record.id === proposed.id
                  ) &&
                  ev !== current.sourceUrl
              )
            );
          });
          if (!read) return "justification_not_independently_read";
        }
      }
      if (
        MISSION_SCORE_AXES.every((axis) =>
          sameScore(old[axis], proposed.scores[axis])
        )
      )
        return "unchanged_score_proposal";
    }
    if (!evidence.some((e) => e.tool === WORK_ITEM_QUERY_NAME))
      return "work_items_unread";
  },
};
