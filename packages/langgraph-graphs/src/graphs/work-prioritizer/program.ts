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
import { createHash } from "node:crypto";
import {
  GOAL_LIST_NAME,
  KNOWLEDGE_READ_NAME,
  semanticJson,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_SEMANTIC_VERSION,
} from "@cogni/ai-tools";
import {
  parseWorkItemScores,
  type WorkItemScore,
  type WorkItemScores,
} from "@cogni/work-items";
import { z } from "zod";
import {
  createEvidenceResultParser,
  type EvidenceProgram,
  type EvidenceReceipt,
  type FrozenEvidence,
} from "../evidence-verification/graph";
import { MISSION_SCORE_AXES, MISSION_SCORE_RUBRIC } from "./rubric";
import { WORK_PRIORITIZER_TOOL_IDS } from "./tools";

const Scores = z.custom<WorkItemScores>().superRefine((value, ctx) => {
  const parsed = parseWorkItemScores(value);
  if (!parsed.ok) {
    for (const issue of parsed.issues)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...issue.path],
        message: issue.message,
        params: { canonicalCode: issue.code },
      });
    return;
  }
  for (const axis of MISSION_SCORE_AXES) {
    if (parsed.value?.[axis] === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [axis],
        message: "Required mission axis; represent unknown as {v:0}",
        params: { canonicalCode: "required_mission_axis" },
      });
  }
});
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
            expectedRevision: z.number().int().nonnegative().optional(),
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

export const MISSION_SELECTION = { limit: 5 } as const;
const POLICY_VERSION = "mission-frozen-evidence-v1";
const digest = (value: unknown) =>
  createHash("sha256").update(semanticJson(value)).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("snapshot_incomplete");
  return value as Record<string, unknown>;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("snapshot_incomplete");
  return value.map(record);
}
/** Incidental counters never reach a role, including through same-ID rereads. */
function decisionItem(item: Record<string, unknown>): Record<string, unknown> {
  const {
    revision: _revision,
    updatedAt: _updatedAt,
    semanticIdentity: _identity,
    ...value
  } = item;
  return {
    ...value,
    labels: Array.isArray(value.labels) ? [...value.labels].sort() : [],
    assignees: Array.isArray(value.assignees)
      ? [...value.assignees].sort((a, b) =>
          semanticJson(a).localeCompare(semanticJson(b))
        )
      : [],
    ...(Array.isArray(value.specRefs)
      ? { specRefs: [...value.specRefs].sort() }
      : {}),
  };
}
export const freezeMissionEvidence: NonNullable<
  EvidenceProgram["freezeEvidence"]
> = ({ evidence: incomingEvidence, sources: incomingSources, task, now }) => {
  const evidence = clone(incomingEvidence);
  const sources = clone(incomingSources);
  const workReceipt = evidence.find((e) => e.tool === WORK_ITEM_QUERY_NAME);
  const goalReceipt = evidence.find((e) => e.tool === GOAL_LIST_NAME);
  if (!workReceipt || !goalReceipt) throw new Error("snapshot_incomplete");
  if (semanticJson(workReceipt.args) !== semanticJson(MISSION_SELECTION))
    throw new Error("snapshot_selection_invalid");
  const work = record(workReceipt.value);
  if (work.paginationKnown !== true)
    throw new Error("snapshot_coverage_unknown");
  const capturedItems = records(work.items).sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );
  if (
    capturedItems.length > MISSION_SELECTION.limit ||
    new Set(capturedItems.map((i) => i.id)).size !== capturedItems.length
  )
    throw new Error("snapshot_incomplete");
  const revisions = new Map<string, number>();
  const fullIdentities = capturedItems.map((item) => {
    const identity = record(item.semanticIdentity);
    if (
      typeof item.id !== "string" ||
      !Number.isSafeInteger(item.revision) ||
      Number(item.revision) < 0 ||
      identity.policyVersion !== WORK_ITEM_SEMANTIC_VERSION ||
      typeof identity.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(identity.digest)
    )
      throw new Error("snapshot_incomplete");
    revisions.set(item.id, Number(item.revision));
    return { id: item.id, ...identity };
  });
  const items = capturedItems.map(decisionItem);
  const goals = records(record(goalReceipt.value).goals)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((goal) => {
      const { revision: _revision, updatedAt: _updatedAt, ...rest } = goal;
      if (typeof goal.id !== "string" || typeof goal.content !== "string")
        throw new Error("snapshot_incomplete");
      const deadline =
        goal.evaluateAt == null ? null : Date.parse(String(goal.evaluateAt));
      if (deadline !== null && !Number.isFinite(deadline))
        throw new Error("snapshot_deadline_invalid");
      return {
        ...rest,
        deadlineState:
          deadline === null
            ? "unspecified"
            : deadline > now
              ? "pending"
              : "past",
      };
    });
  const frozenSources = sources
    .map((source) => ({
      id: source.id,
      content: source.content,
      entryType: source.entryType ?? null,
      tags: Array.isArray(source.tags) ? [...source.tags].sort() : [],
      title: source.title ?? null,
      useWhen: source.useWhen ?? null,
      sourceUrl: source.sourceUrl ?? null,
      sourceUrlUnavailable: source.sourceUrlUnavailable === true,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const page = {
    items,
    count: items.length,
    hasMore: typeof work.nextCursor === "string",
    coverage: "first-five-priority-rank-created-id-v1",
  };
  const goalPage = { goals };
  const initial: EvidenceReceipt[] = evidence.map((e) => {
    const value =
      e.tool === WORK_ITEM_QUERY_NAME
        ? page
        : e.tool === GOAL_LIST_NAME
          ? goalPage
          : undefined;
    if (!value) throw new Error("snapshot_incomplete");
    return { ...e, value: clone(value), sha256: digest(value) };
  });
  const identity = {
    policyVersion: POLICY_VERSION,
    digest: digest({
      policy: POLICY_VERSION,
      selection: MISSION_SELECTION,
      coverage: page.coverage,
      hasMore: page.hasMore,
      task,
      sources: frozenSources,
      goals,
      items: fullIdentities,
      // Hash exact visible excerpts too: schema/cap changes must invalidate identity.
      decisionItems: items,
    }),
  };
  const frozen: FrozenEvidence = {
    evidence: initial,
    sources: frozenSources,
    inputIdentity: identity,
    read(name, args) {
      if (name === GOAL_LIST_NAME && Object.keys(args).length === 0)
        return clone(goalPage);
      if (
        name === KNOWLEDGE_READ_NAME &&
        Object.keys(args).length === 1 &&
        typeof args.id === "string"
      ) {
        const source = frozenSources.find((s) => s.id === args.id);
        if (source)
          return { mode: "get", totalFound: 1, entries: [clone(source)] };
      }
      if (name === WORK_ITEM_QUERY_NAME) {
        if (semanticJson(args) === semanticJson(MISSION_SELECTION))
          return clone(page);
        // Exact-ID reads are subsets of the captured set; no live query occurs.
        if (
          Object.keys(args).every((key) => key === "ids" || key === "limit") &&
          Array.isArray(args.ids) &&
          args.ids.length > 0 &&
          args.ids.every((id) => typeof id === "string" && revisions.has(id)) &&
          (args.limit === undefined || args.limit === args.ids.length)
        ) {
          const selected = items.filter((item) =>
            (args.ids as unknown[]).includes(item.id)
          );
          return clone({
            items: selected,
            count: selected.length,
            hasMore: false,
            coverage: page.coverage,
          });
        }
      }
      throw new Error("outside_snapshot");
    },
    finalizeProposal(proposal) {
      const value = clone(record(proposal));
      const payload = record(value.payload);
      payload.items = records(payload.items).map((item) => {
        const revision = revisions.get(String(item.id));
        if (revision === undefined) throw new Error("outside_snapshot");
        return { ...item, expectedRevision: revision };
      });
      return value;
    },
  };
  return frozen;
};

/** Program policy is code-owned, not an instruction found in a backlog item. */
export const MISSION_EVIDENCE_PROGRAM: EvidenceProgram = {
  id: "mission-prioritization",
  version: "4.2",
  freezeEvidence: freezeMissionEvidence,
  requiredSources: [
    { id: "mission-loop-expert", kind: "skill" },
    { id: "dao-goals-design", kind: "reference" },
  ],
  readToolIds: WORK_PRIORITIZER_TOOL_IDS,
  initialReads: [
    { tool: GOAL_LIST_NAME, args: {} },
    { tool: WORK_ITEM_QUERY_NAME, args: MISSION_SELECTION },
  ],
  assignment: `Read approved goals and current work items. Propose at most five justified six-axis Evaluation assessments, or a supported no-change result. Evaluate every explicitly requested candidate when there are at most five, including poor goal fits; do not silently skip unsupported candidates. This pilot is strictly read-only. Never write work items, priority, rank, goals or EDO. Host write authorization remains separate from this pilot policy. The host already captured the first five work items in priority/rank/created/id order. Scope is only this bounded selection, not the full backlog. You may reread exactly core__work_item_query {"limit":5}, or selected IDs with {"ids":[...]}; other queries, pagination, new knowledge and current-time reads are forbidden and terminate the run. Required guidance and goals are frozen too. deadlineState is the sole current-time evidence. Do not invent revisions: the host attaches expectedRevision after verification. Preserve every existing extra score axis unchanged in the proposed complete scores object; do not invent axes. Put explanations and receipt IDs in support, never inside scores. Work query summaries/outcomes are bounded excerpts, not full evidence of their claims. ${MISSION_SCORE_RUBRIC}`,
  criteria: `Scope is only the host-captured selection, not the full backlog; do not require outside candidates or facts. Required guidance and goals are frozen, deadlineState is the sole current-time evidence, and the host attaches expectedRevision after verification. Check every item against captured primary work-item reads, goal against approved goal IDs, each score against specific support. Check every explicitly requested candidate was assessed when there are at most five, including poor goal fits, or explicitly identified as unsupported. Preserve every existing extra score axis unchanged; no invented axes. Explanations and receipt IDs belong in support, not scores. Read summaries/outcomes are bounded excerpts, not proof of unseen contents. For every axis, identify the cited primary fact and check that it entails the chosen rubric anchor; valid schema and URL membership alone are insufficient. A goal deadline alone does not establish current cost of delay, and the ban on self URLs as ev does not invalidate directly read item requirements supporting low scores. Revise proposals that confuse either distinction, even when every field and URL is valid. A generic goal does not establish urgency, dependencies, effort, confidence or autonomy. Missing source contents remain unknown or lower confidence. Reject unsupported scores at every nonzero level, including 1–3, invented urgency or effort, uncaptured facts and unchanged score/evidence proposals. No-change must follow actual reads. This result is a proposal, never an effect receipt. ${MISSION_SCORE_RUBRIC}`,
  payloadSchema: Payload,
  resultPayloadSchema: z
    .object({
      items: z
        .array(
          Payload.shape.items.element.extend({
            expectedRevision: z.number().int().nonnegative(),
          })
        )
        .max(5),
    })
    .strict(),
  repairableValidationErrors: [
    "no_change_has_proposals",
    "empty_proposal",
    "duplicate_proposal_id",
    "unknown_goal",
    "item_or_revision_unread",
    "extra_axes_not_preserved",
    "unsupported_axis_evidence",
    "justification_not_independently_read",
    "unchanged_score_proposal",
  ],
  payloadDescription:
    '{items:[{id:string,goalId:string,rationale:string,scores:{goal:{v:0..5,ev?:"https URL"},time:{v,ev?},unblocks:{v,ev?},ease:{v,ev?},confidence:{v,ev?},agent:{v,ev?},...unchanged existing extra axes},support:{goal:{rationale:string,evidenceIds:string[]},time:{rationale,evidenceIds},unblocks:{rationale,evidenceIds},ease:{rationale,evidenceIds},confidence:{rationale,evidenceIds},agent:{rationale,evidenceIds}}}]} (empty items for no_change; scores must satisfy shared canonical validator; all six axes required, unknown is {v:0}, never {}; each support.evidenceIds is nonempty and cites actual inspected receipts even when explaining uncertainty; omit ev when no qualifying independent source was read, never use the scored item URL)',
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
    if (new Set(p.items.map((item) => item.id)).size !== p.items.length)
      return "duplicate_proposal_id";
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
        (i) =>
          i.id === proposed.id &&
          (i.revision === undefined ||
            proposed.expectedRevision === undefined ||
            i.revision === proposed.expectedRevision)
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

export const parseMissionEvidenceResult = createEvidenceResultParser(
  MISSION_EVIDENCE_PROGRAM
);
