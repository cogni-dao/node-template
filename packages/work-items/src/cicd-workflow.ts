// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/cicd-workflow`
 * Purpose: Executable, reviewed CI/CD definitions and declared-policy variants for nodes.
 * Scope: Guidance and receipt requirements only; no action dispatch or evidence certification.
 * Invariants: ONE_SHA, OPERATOR_SHIPS, GUIDANCE_AT_CHECKPOINT.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/cicd-e2e-required-sequence
 * @public
 */
import type { WorkflowDefinition } from "./workflow.js";

export const CICD_WORKFLOW = {
  id: "cicd-v1",
  subject: {
    field: "headSha",
    rewindTo: "review_ci",
    sealedBy: "mergeSha",
  },
  checkpoints: [
    {
      id: "implementation",
      instruction:
        "Read the linked operator /implement contract and the approved item/design. Reuse this node identity; obtain missing developer access through the operator and accept the matching GitHub invitation. Respect the current workspace branch. Implement with targeted before/after proof, open the node PR and link its branch and current head. Start fresh implementation review immediately while CI runs.",
      requiredEvidence: {
        prUrl: "url",
        branch: "string",
        headSha: "sha",
        changeEvidence: "url",
        implementerSession: "string",
      },
      pending:
        "Pending access is a human permission gate. Failed checks return to implementation. No PR/head means remain here.",
      retry:
        "Read back an uncertain PR creation/link before repeating it. Completion records the existing PR; it never opens another PR.",
      sources: [
        "https://cognidao.org/knowledge/cicd-e2e-required-sequence",
        "https://github.com/cogni-dao/cogni/blob/3f5d91400a11433299aca719f925d1d2203b3896/.claude/commands/implement.md",
      ],
      nextLifecycleStatus: "needs_merge",
      capture: ["headSha", "prUrl", "implementerSession"],
    },
    {
      id: "review_ci",
      instruction:
        "Read the linked operator /review-implementation contract. A fresh agent performs separate Spec and Standards reviews against the current merge-base/head. Release trusted CI through the operator only if this is a fork needing release. Watch gh pr checks PR --watch --fail-fast, then reread the current head and checks. Advance only with independent APPROVE and CI pass for that same head.",
      requiredEvidence: {
        headSha: "sha",
        reviewUrl: "url",
        reviewVerdict: "APPROVE",
        reviewerSession: "string",
        ciUrl: "url",
        ciVerdict: "PASS",
      },
      pending:
        "REQUEST CHANGES returns to implementation work without completing this checkpoint. Pending/failed CI stays here. A new head requires reconcile-head before another completion.",
      retry:
        "Reuse actual check/review receipts. Re-read after watcher exit; watcher completion alone is not CI pass.",
      sources: [
        "https://cognidao.org/knowledge/cicd-e2e-required-sequence",
        "https://github.com/cogni-dao/cogni/blob/3f5d91400a11433299aca719f925d1d2203b3896/.claude/commands/review-implementation.md",
      ],
      checks: [
        {
          field: "headSha",
          binding: "headSha",
          relation: "equals",
        },
        {
          field: "reviewerSession",
          binding: "implementerSession",
          relation: "differs",
        },
      ],
    },
    {
      id: "flight",
      instruction:
        "Re-read the current PR head and same-head review/CI evidence. Dispatch POST /api/v1/vcs/flight through the operator with nodeRef:{nodeId,sourceSha}. Candidate/provider placement belongs to the operator. Watch the discovered candidate /version until buildSha equals this head, with a bounded failure exit. Require the matching candidate-flight run to finish SUCCESS as well as the exact version match.",
      requiredEvidence: {
        headSha: "sha",
        flightReceipt: "url",
        candidateVersionUrl: "url",
        candidateBuildSha: "sha",
        flightVerdict: "SUCCESS",
      },
      pending:
        "Missing exact SHA, failed dispatch or timeout stays here. Instruction-only/native-only flight n/a needs an explicitly reviewed exception; no inferred skip.",
      retry:
        "An uncertain flight is reconciled via its existing receipt and candidate /version; completion never redispatches a flight.",
      sources: ["https://cognidao.org/knowledge/cicd-e2e-required-sequence"],
      checks: [
        {
          field: "headSha",
          binding: "headSha",
          relation: "equals",
        },
        {
          field: "candidateBuildSha",
          binding: "headSha",
          relation: "equals",
        },
      ],
    },
    {
      id: "candidate_validation",
      instruction:
        "Load validate-candidate in full. Verify exact candidate build and readiness, exercise the changed behavior and required authentication paths, and obtain feature-specific Loki evidence at the same SHA. Publish its PASS scorecard on the PR. Keep the validator zero-artifact; its outer caller records this checkpoint.",
      requiredEvidence: {
        headSha: "sha",
        scorecardUrl: "url",
        scorecardVerdict: "PASS",
        behaviorEvidence: "url",
        lokiEvidence: "url",
      },
      pending:
        "A version match alone fails validation. Missing behavior/log evidence stays here. Reviewed native-only proof must explicitly cover the changed native surface.",
      retry:
        "Repeat reads/probes safely when evidence is incomplete; do not replay a previous flight merely because recording validation failed.",
      sources: [
        "https://cognidao.org/knowledge/cicd-e2e-required-sequence",
        "https://cognidao.org/knowledge/validate-candidate",
        "https://cognidao.org/knowledge/node-observability-finish-pass",
      ],
      nextLifecycleStatus: "needs_closeout",
      checks: [
        {
          field: "headSha",
          binding: "headSha",
          relation: "equals",
        },
      ],
    },
    {
      id: "merge",
      instruction:
        "Read the linked operator /closeout contract. Re-read the current PR head and confirm independent review, CI and validation PASS at that head. Merge only via POST /api/v1/vcs/merge with nodeId and prNumber. Watch/read back actual PR merged state and the resulting merge SHA, then record this checkpoint and lifecycle done.",
      requiredEvidence: {
        headSha: "sha",
        mergedPrUrl: "url",
        mergeSha: "sha",
        mergeVerdict: "MERGED",
      },
      pending:
        "Any stale/missing gate stays here; a merge request response is not merged state. New head requires reconcile-head before completion.",
      retry:
        "Read actual PR state/operator receipt before repeating an uncertain merge. complete never performs the merge.",
      sources: [
        "https://cognidao.org/knowledge/cicd-e2e-required-sequence",
        "https://github.com/cogni-dao/cogni/blob/3f5d91400a11433299aca719f925d1d2203b3896/.claude/commands/closeout.md",
      ],
      nextLifecycleStatus: "done",
      checks: [
        {
          field: "headSha",
          binding: "headSha",
          relation: "equals",
        },
      ],
      capture: ["mergeSha"],
    },
    {
      id: "preview",
      instruction:
        "Observe the existing automatic preview deployment after main merge. Read preview /version until its buildSha equals the recorded merge SHA; exercise the changed behavior at that build.",
      requiredEvidence: {
        headSha: "sha",
        previewVersionUrl: "url",
        previewBuildSha: "sha",
        previewBehaviorEvidence: "url",
      },
      pending:
        "A green deploy workflow without the matching live SHA and behavior stays here.",
      retry:
        "Use bounded read-only version/behavior probes. Do not dispatch an invented preview action.",
      sources: ["https://cognidao.org/knowledge/cicd-e2e-required-sequence"],
      checks: [
        {
          field: "headSha",
          binding: "headSha",
          relation: "equals",
        },
        {
          field: "previewBuildSha",
          binding: "mergeSha",
          relation: "equals",
        },
      ],
    },
    {
      id: "production",
      instruction:
        "Load the promotion contract. Use POST /api/v1/deploy/promote through the operator with nodeId and env:production, subject to the existing grant. Watch production /version until its buildSha equals the promoted merge SHA. Reprove the changed behavior and relevant logs at that build before completing the workflow. Pin sourceSha to the recorded mergeSha in the promotion request; do not rely on a moving catalog default. Follow the linked /closeout Phase 2 step 4: user-facing changes wait for a human to look before production. Promotion still requires its existing authorization.",
      requiredEvidence: {
        headSha: "sha",
        promotionReceipt: "url",
        productionVersionUrl: "url",
        productionBuildSha: "sha",
        productionBehaviorEvidence: "url",
        productionLokiEvidence: "url",
        promotedSourceSha: "sha",
      },
      pending:
        "Missing permission is a real human gate; failed/pending rollout or missing behavior evidence stays here. Do not call the workflow complete at merge.",
      retry:
        "Reconcile an uncertain promotion against its receipt and actual production version before another dispatch.",
      sources: [
        "https://cognidao.org/knowledge/cicd-e2e-required-sequence",
        "https://github.com/cogni-dao/cogni/blob/3f5d91400a11433299aca719f925d1d2203b3896/.claude/skills/promote/SKILL.md",
        "https://github.com/cogni-dao/cogni/blob/3f5d91400a11433299aca719f925d1d2203b3896/.claude/commands/closeout.md",
      ],
      checks: [
        {
          field: "headSha",
          binding: "headSha",
          relation: "equals",
        },
        {
          field: "productionBuildSha",
          binding: "mergeSha",
          relation: "equals",
        },
        {
          field: "promotedSourceSha",
          binding: "mergeSha",
          relation: "equals",
        },
      ],
    },
  ],
} as const satisfies WorkflowDefinition;

/** Reviewed declared-policy variant; never infer this from runtime failure. */
export const CICD_NO_PREVIEW_WORKFLOW = {
  ...CICD_WORKFLOW,
  id: "cicd-no-preview-v1",
  checkpoints: CICD_WORKFLOW.checkpoints
    .filter((checkpoint) => checkpoint.id !== "preview")
    .map((checkpoint) =>
      checkpoint.id === "implementation"
        ? {
            ...checkpoint,
            instruction: `${checkpoint.instruction} Use this variant only when the owning node catalog explicitly omits preview. Inspect that node's pinned catalog policy, not merely an unhealthy or absent runtime. Record NOT_CONFIGURED and the pinned policy URL before completing implementation.`,
            requiredEvidence: {
              ...checkpoint.requiredEvidence,
              previewPolicy: "NOT_CONFIGURED",
              environmentPolicyEvidence: "url",
            },
            capture: [
              ...checkpoint.capture,
              "previewPolicy",
              "environmentPolicyEvidence",
            ],
            sources: [
              ...checkpoint.sources,
              "https://cognidao.org/knowledge/operator-node-catalog",
            ],
          }
        : checkpoint,
    ),
} as const satisfies WorkflowDefinition;

export const CICD_WORKFLOWS: readonly WorkflowDefinition[] = [
  CICD_WORKFLOW,
  CICD_NO_PREVIEW_WORKFLOW,
];
