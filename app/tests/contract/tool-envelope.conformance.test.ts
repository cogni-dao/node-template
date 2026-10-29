// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/tool-envelope.conformance`
 * Purpose: Enforce the `agent-tool-context-envelope` standard repo-wide with ONE
 *   registry-level audit (shared `auditToolEnvelopes` from @cogni/ai-tools) over
 *   the whole tool catalog — not a per-entity test. A new tool, a new wire-DTO
 *   field, or a shrinking-ledger regression fails here.
 * Scope: Classifies every catalog tool as envelope-mapped or no-envelope, and for
 *   mapped tools compares the tool's output-item key-set to its wire DTO. The app
 *   tier is the one place both zod majors (ai-tools zod3, node-contracts zod4) are
 *   visible; key-sets compare as plain data.
 * Side-effects: none
 * Links: packages/ai-tools/src/tool-envelope.ts, knowledge entry agent-tool-context-envelope
 * @internal
 */

import {
  auditToolEnvelopes,
  getToolIds,
  KnowledgeReadEntrySchema,
  type ToolEnvelopeSpec,
  WorkItemOutputSchema,
  type WorkItemQueryOutput,
} from "@cogni/ai-tools";
import {
  KnowledgeRowSchema,
  WorkItemDtoSchema,
  type WorkItemDto,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const keys = (shape: Record<string, unknown>): string[] => Object.keys(shape);

// Complementary TYPE-parity guard (presence is covered by the audit below). tsc
// fails if `core__work_item_query` drops or RETYPES any pinned planner field vs
// the wire DTO — the per-field guarantee the registry audit alone cannot give.
// Never called; its existence type-checks.
type WorkItemToolItem = WorkItemQueryOutput["items"][number];
const WORK_ITEM_PINNED = [
  "id",
  "type",
  "status",
  "priority",
  "rank",
  "rankScore",
  "scores",
  "labels",
  "blockedBy",
  "branch",
  "pr",
  "createdAt",
  "updatedAt",
  "deployVerified",
] as const;
export const _workItemTypeParity = (
  i: WorkItemToolItem
): Pick<WorkItemDto, (typeof WORK_ITEM_PINNED)[number]> => ({
  id: i.id,
  type: i.type,
  status: i.status,
  priority: i.priority,
  rank: i.rank,
  rankScore: i.rankScore,
  scores: i.scores,
  labels: i.labels,
  blockedBy: i.blockedBy,
  branch: i.branch,
  pr: i.pr,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  deployVerified: i.deployVerified,
});

/** Envelope-mapped tools: output item must mirror the wire DTO (minus `excluded`). */
const SPECS: readonly ToolEnvelopeSpec[] = [
  {
    toolId: "core__work_item_query",
    toolItemKeys: keys(WorkItemOutputSchema.shape),
    wireKeys: keys(WorkItemDtoSchema.shape),
    // Routing/attribution/lifecycle fields a planner does not reason over.
    excluded: [
      "node",
      "externalRefs",
      "reviewer",
      "claimedByRun",
      "claimedAt",
      "lastCommand",
    ],
  },
  {
    toolId: "core__knowledge_read",
    toolItemKeys: keys(KnowledgeReadEntrySchema.shape),
    wireKeys: keys(KnowledgeRowSchema.shape),
    // TRANSITIONAL ledger — owned fix in flight on branch derekg1729/knowledge-envelope
    // (knowledge-read field-carry). Carrying any of these fails as stale (forced out);
    // ADDING a new entry is gated by human diff review, not prevented structurally.
    knownMissing: [
      "useWhen",
      "entryType",
      "evaluateAt",
      "resolutionStrategy",
      "createdAt",
    ],
  },
];

/**
 * Tools that genuinely surface no wire-DTO item envelope: actions, scalars, and
 * free-text results with no canonical row DTO to mirror. Frozen on purpose — a NEW
 * catalog tool absent from SPECS and both opt-out lists fails the audit, forcing a
 * conscious envelope classification.
 */
const NO_ENVELOPE_TOOLS: readonly string[] = [
  "core__goal_list",
  "core__get_current_time",
  "core__metrics_query",
  "core__repo_list",
  "core__repo_open",
  "core__repo_search",
  "core__schedule_list",
  "core__schedule_manage",
  "core__web_search",
  "core__work_item_transition",
  "core__edo_decide",
  "core__edo_hypothesize",
  "core__edo_record_outcome",
  "core__vcs_create_branch",
  "core__vcs_flight_candidate",
  "core__vcs_get_ci_status",
  "core__vcs_list_prs",
  "core__vcs_merge_pr",
];

/**
 * Envelope-BEARING tools whose wire-DTO mapping is not yet wired into SPECS. They
 * DO have a context envelope and carry the same drift class — they are not "no
 * envelope". Promoting each into SPECS (with its wire DTO) is owned follow-up work
 * (knowledge-envelope task). Listed separately so the opt-out stays honest.
 */
const DEFERRED_ENVELOPE_TOOLS: readonly string[] = [
  "core__knowledge_search",
  "core__knowledge_write",
];

describe("tool envelope conformance — repo-wide registry audit (agent-tool-context-envelope)", () => {
  const audit = auditToolEnvelopes({
    allToolIds: getToolIds(),
    specs: SPECS,
    noEnvelopeTools: [...NO_ENVELOPE_TOOLS, ...DEFERRED_ENVELOPE_TOOLS],
  });

  it("classifies every catalog tool (new tool must declare an envelope or opt out)", () => {
    expect(audit.unclassified).toEqual([]);
    expect(audit.unknownIds).toEqual([]);
  });

  it("no mapped tool drops a wire-DTO field it neither excludes nor tracks", () => {
    expect(audit.violations).toEqual([]);
  });

  it("no settled known-missing debt lingers (carried field forced out of ledger)", () => {
    expect(audit.staleKnownMissing).toEqual([]);
  });

  it("every excluded / known-missing key is a real wire field (no spec rot)", () => {
    expect(audit.unknownSpecKeys).toEqual([]);
  });
});
