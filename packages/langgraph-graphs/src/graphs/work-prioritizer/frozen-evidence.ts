// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Mission pilot capture policy. Bounded invocation memory; no persistent snapshot store. */
import { createHash } from "node:crypto";
import {
  GOAL_LIST_NAME,
  KNOWLEDGE_READ_NAME,
  semanticJson,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_SEMANTIC_VERSION,
} from "@cogni/ai-tools";
import type {
  EvidenceProgram,
  EvidenceReceipt,
  FrozenEvidence,
} from "../evidence-verification/graph";

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
