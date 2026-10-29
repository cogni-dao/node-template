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
} from "@cogni/ai-tools";
import {
  KnowledgeRowSchema,
  WorkItemDtoSchema,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const keys = (shape: Record<string, unknown>): string[] => Object.keys(shape);

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
    // TRANSITIONAL ledger — owned fix in flight (knowledge-read field-carry).
    // New drift outside this set fails; carrying any of these fails as stale, so
    // the ledger can only shrink to empty.
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
 * Tools that surface no wire-DTO item envelope (actions, scalars, free search).
 * Frozen on purpose: a NEW catalog tool absent from SPECS and this list fails the
 * audit, forcing a conscious envelope classification.
 * TODO(knowledge-envelope task): promote core__knowledge_search / core__knowledge_write
 * into SPECS once their wire DTOs are mapped.
 */
const NO_ENVELOPE_TOOLS: readonly string[] = [
  "core__knowledge_search",
  "core__knowledge_write",
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

describe("tool envelope conformance — repo-wide registry audit (agent-tool-context-envelope)", () => {
  const audit = auditToolEnvelopes({
    allToolIds: getToolIds(),
    specs: SPECS,
    noEnvelopeTools: NO_ENVELOPE_TOOLS,
  });

  it("classifies every catalog tool (new tool must declare an envelope or opt out)", () => {
    expect(audit.unclassified).toEqual([]);
    expect(audit.unknownIds).toEqual([]);
  });

  it("no mapped tool drops a wire-DTO field it neither excludes nor tracks", () => {
    expect(audit.violations).toEqual([]);
  });

  it("the known-missing ledger only shrinks (no stale tracked fields)", () => {
    expect(audit.staleKnownMissing).toEqual([]);
  });
});
