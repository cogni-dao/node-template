// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/workflow`
 * Purpose: Exercise reusable progression, recovery, edits, replay and stale subject evidence.
 * Scope: Pure domain tests; no database mocks or claims of native/live proof.
 * Invariants: ONE_CHECKPOINT, RECEIPT_REPLAY, SUBJECT_SCOPED.
 * Side-effects: none
 * @internal
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CICD_NO_PREVIEW_WORKFLOW,
  CICD_WORKFLOW,
} from "../src/cicd-workflow.js";
import { canonicalJson } from "../src/json.js";
import {
  nextWorkflowCheckpoint,
  transitionWorkflow,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowRun,
  workflowFingerprintInputs,
} from "../src/workflow.js";

const A = "a".repeat(40),
  B = "b".repeat(40),
  M = "c".repeat(40);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identity(definition: WorkflowDefinition = CICD_WORKFLOW) {
  const inputs = workflowFingerprintInputs(definition);
  return {
    definitionHash: digest(inputs.definition),
    structureHash: digest(inputs.structure),
  };
}
function apply(
  run: WorkflowRun | undefined,
  event: WorkflowEvent,
  definition: WorkflowDefinition = CICD_WORKFLOW,
) {
  return transitionWorkflow(
    run,
    event,
    definition,
    identity(definition),
    digest(event),
    "2026-10-23T00:00:00Z",
  );
}
function start() {
  return apply(undefined, { op: "start", workflowId: CICD_WORKFLOW.id }).run;
}
function evidence(id: string, headSha = A): Record<string, string> {
  const checkpoint = CICD_WORKFLOW.checkpoints.find((step) => step.id === id);
  if (!checkpoint) throw new Error(id);
  const result: Record<string, string> = {};
  for (const [field, rule] of Object.entries(checkpoint.requiredEvidence))
    result[field] =
      rule === "sha"
        ? headSha
        : rule === "url"
          ? `https://example.test/${id}/${field}`
          : rule === "string"
            ? `${id}-${field}`
            : rule;
  if (id === "merge") result.mergeSha = M;
  if (id === "preview") result.previewBuildSha = M;
  if (id === "production") {
    result.productionBuildSha = M;
    result.promotedSourceSha = M;
  }
  return result;
}
function complete(
  run: WorkflowRun,
  fields = evidence(run.checkpointId ?? ""),
  key = run.checkpointId ?? "",
) {
  return apply(run, {
    op: "complete",
    workflowId: run.workflowId,
    checkpointId: run.checkpointId ?? "",
    definitionHash: identity().definitionHash,
    receiptKey: key,
    evidence: fields,
  });
}

describe("executable checkpoint workflow", () => {
  it("reuses one definition for two independent full seven-checkpoint runs", () => {
    for (let execution = 0; execution < 2; execution++) {
      let run = start();
      for (const checkpoint of CICD_WORKFLOW.checkpoints) {
        expect(run.checkpointId).toBe(checkpoint.id);
        const packet = nextWorkflowCheckpoint(run, CICD_WORKFLOW, identity());
        expect(packet).toMatchObject({
          checkpointId: checkpoint.id,
          instruction: checkpoint.instruction,
        });
        expect(JSON.stringify(packet)).not.toContain('"checkpoints"');
        run = complete(run).run;
      }
      expect(
        nextWorkflowCheckpoint(run, CICD_WORKFLOW, identity()),
      ).toMatchObject({ done: true });
      expect(run.receipts).toHaveLength(7);
    }
  });
  it("resumes serialized state at the exact checkpoint without restarting", () => {
    const run = complete(complete(start()).run).run;
    const recovered = JSON.parse(JSON.stringify(run));
    expect(
      nextWorkflowCheckpoint(recovered, CICD_WORKFLOW, identity()).checkpointId,
    ).toBe("flight");
    expect(
      apply(recovered, { op: "start", workflowId: run.workflowId }).run,
    ).toEqual(recovered);
  });
  it("does not advance or mutate state on next", () => {
    const run = start(),
      before = JSON.stringify(run);
    nextWorkflowCheckpoint(run, CICD_WORKFLOW, identity());
    nextWorkflowCheckpoint(run, CICD_WORKFLOW, identity());
    expect(JSON.stringify(run)).toBe(before);
  });
  it("cannot skip a checkpoint", () => {
    expect(() =>
      apply(start(), {
        op: "complete",
        workflowId: CICD_WORKFLOW.id,
        checkpointId: "merge",
        definitionHash: identity().definitionHash,
        receiptKey: "skip",
        evidence: evidence("merge"),
      }),
    ).toThrow("wrong_checkpoint");
  });
  it("refuses missing or failed evidence", () => {
    const run = complete(start()).run;
    const missing = evidence("review_ci");
    delete missing.ciUrl;
    expect(() => complete(run, missing)).toThrow(
      "missing_or_invalid_evidence:ciUrl",
    );
    expect(() =>
      complete(run, { ...evidence("review_ci"), ciVerdict: "PENDING" }),
    ).toThrow("invalid_verdict:ciVerdict");
  });
  it("requires an independent reviewer attestation and labels its authority", () => {
    const first = evidence("implementation");
    const run = complete(start(), first).run;
    expect(() =>
      complete(run, {
        ...evidence("review_ci"),
        reviewerSession: first.implementerSession ?? "",
      }),
    ).toThrow("evidence_mismatch:reviewerSession");
    expect(
      nextWorkflowCheckpoint(run, CICD_WORKFLOW, identity()),
    ).toHaveProperty(
      "evidenceAuthority",
      expect.stringContaining("agent-attested"),
    );
  });
  it("refuses stale-head review and deployment evidence", () => {
    const run = complete(start()).run;
    expect(() => complete(run, evidence("review_ci", B))).toThrow(
      "evidence_mismatch:headSha",
    );
    const flight = complete(run).run;
    expect(() =>
      complete(flight, { ...evidence("flight"), candidateBuildSha: B }),
    ).toThrow("evidence_mismatch:candidateBuildSha");
  });
  it("does not advance twice after a lost completion response", () => {
    const event: WorkflowEvent = {
      op: "complete",
      workflowId: CICD_WORKFLOW.id,
      checkpointId: "implementation",
      definitionHash: identity().definitionHash,
      receiptKey: "stable-key",
      evidence: evidence("implementation"),
    };
    const stored = apply(start(), event).run;
    const replay = apply(JSON.parse(JSON.stringify(stored)), event);
    expect(replay.replayed).toBe(true);
    expect(replay.run.checkpointId).toBe("review_ci");
    expect(replay.run.receipts).toHaveLength(1);
    expect(() =>
      apply(stored, {
        ...event,
        evidence: { ...event.evidence, branch: "different" },
      }),
    ).toThrow("receipt_key_conflict");
  });
  it("applies guidance edits on next and refuses completion using the old guidance", () => {
    const edited = structuredClone(
      CICD_WORKFLOW,
    ) as unknown as WorkflowDefinition;
    const changed: WorkflowDefinition = {
      ...edited,
      checkpoints: edited.checkpoints.map((step, index) =>
        index ? step : { ...step, instruction: "Reviewed revised instruction" },
      ),
    };
    const run = start();
    expect(identity(changed).structureHash).toBe(identity().structureHash);
    expect(
      nextWorkflowCheckpoint(run, changed, identity(changed)),
    ).toHaveProperty("instruction", "Reviewed revised instruction");
    expect(() =>
      apply(
        run,
        {
          op: "complete",
          workflowId: run.workflowId,
          checkpointId: "implementation",
          definitionHash: identity().definitionHash,
          receiptKey: "old-guidance",
          evidence: evidence("implementation"),
        },
        changed,
      ),
    ).toThrow("guidance_changed_refresh_required");
  });
  it("holds structurally incompatible runs instead of silently migrating them", () => {
    const changed: WorkflowDefinition = {
      ...CICD_WORKFLOW,
      checkpoints: CICD_WORKFLOW.checkpoints.slice(1),
    };
    expect(
      nextWorkflowCheckpoint(start(), changed, identity(changed)),
    ).toHaveProperty("blocked", "workflow_definition_changed");
  });
  it("records head reconciliation, rewinds and refuses changes after merge", () => {
    let run = complete(complete(complete(start()).run).run).run;
    const event: WorkflowEvent = {
      op: "reconcile-head",
      workflowId: run.workflowId,
      definitionHash: identity().definitionHash,
      receiptKey: "head-B",
      headSha: B,
    };
    run = apply(run, event).run;
    expect(run.checkpointId).toBe("review_ci");
    expect(run.bindings.headSha).toBe(B);
    expect(() =>
      complete(run, evidence("review_ci", A), "stale-review"),
    ).toThrow("evidence_mismatch:headSha");
    expect(apply(run, event).replayed).toBe(true);
    for (const id of ["review_ci", "flight", "candidate_validation", "merge"])
      run = complete(run, evidence(id, B), `B-${id}`).run;
    expect(() =>
      apply(run, { ...event, receiptKey: "head-A", headSha: A }),
    ).toThrow("subject_sealed_after_merge");
  });
  it("requires preview and production to match the recorded merged build", () => {
    let run = start();
    for (let i = 0; i < 5; i++) run = complete(run).run;
    expect(() =>
      complete(run, { ...evidence("preview"), previewBuildSha: A }),
    ).toThrow("evidence_mismatch:previewBuildSha");
    run = complete(run).run;
    expect(() =>
      complete(run, { ...evidence("production"), promotedSourceSha: A }),
    ).toThrow("evidence_mismatch:promotedSourceSha");
  });
});

it("canonicalizes nested database JSON object order while retaining array semantics", () => {
  const run = complete(start()).run;
  const reverseObjects = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reverseObjects)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, child]) => [key, reverseObjects(child)]),
          )
        : value;
  expect(canonicalJson(reverseObjects(run))).toBe(canonicalJson(run));
  expect(canonicalJson({ receipts: ["a", "b"] })).not.toBe(
    canonicalJson({ receipts: ["b", "a"] }),
  );
});
it("returns bounded last receipt on recovery and completion", () => {
  let run = start();
  expect(
    nextWorkflowCheckpoint(run, CICD_WORKFLOW, identity()).lastReceipt,
  ).toBeNull();
  run = complete(run).run;
  let packet = nextWorkflowCheckpoint(
    JSON.parse(JSON.stringify(run)),
    CICD_WORKFLOW,
    identity(),
  );
  expect(packet.lastReceipt).toMatchObject({
    key: "implementation",
    checkpointId: "implementation",
  });
  expect(packet.lastReceipt).not.toHaveProperty("evidence");
  for (let i = 1; i < CICD_WORKFLOW.checkpoints.length; i++)
    run = complete(run).run;
  packet = nextWorkflowCheckpoint(run, CICD_WORKFLOW, identity());
  expect(packet).toMatchObject({
    done: true,
    lastReceipt: { checkpointId: "production" },
  });
});

it("requires explicit no-preview policy attestation and preserves the standard workflow", () => {
  const definition = CICD_NO_PREVIEW_WORKFLOW;
  const run = apply(
    undefined,
    { op: "start", workflowId: definition.id },
    definition,
  ).run;
  expect(CICD_WORKFLOW.checkpoints.map((step) => step.id)).toContain("preview");
  expect(definition.checkpoints.map((step) => step.id)).toEqual([
    "implementation",
    "review_ci",
    "flight",
    "candidate_validation",
    "merge",
    "production",
  ]);
  const event = {
    op: "complete" as const,
    workflowId: definition.id,
    checkpointId: "implementation",
    definitionHash: identity(definition).definitionHash,
    receiptKey: "implementation",
    evidence: evidence("implementation"),
  };
  expect(() => apply(run, event, definition)).toThrow(
    "missing_or_invalid_evidence:previewPolicy",
  );
  expect(() =>
    apply(
      run,
      {
        ...event,
        evidence: {
          ...event.evidence,
          previewPolicy: "UNHEALTHY",
          environmentPolicyEvidence: "https://example.test/policy",
        },
      },
      definition,
    ),
  ).toThrow("invalid_verdict:previewPolicy");
  expect(() =>
    apply(run, { op: "start", workflowId: CICD_WORKFLOW.id }),
  ).toThrow("workflow_definition_changed");
});
it("completes the explicitly selected six-stage variant with the same receipt protocol", () => {
  const definition = CICD_NO_PREVIEW_WORKFLOW;
  let run = apply(
    undefined,
    { op: "start", workflowId: definition.id },
    definition,
  ).run;
  for (const step of definition.checkpoints) {
    const fields = evidence(step.id);
    if (step.id === "implementation") {
      fields.previewPolicy = "NOT_CONFIGURED";
      fields.environmentPolicyEvidence =
        "https://github.com/cogni-dao/cogni/blob/e4bf3e4444e3a359af8a7a9f7aca3b07ffaeab1b/infra/catalog/node-template.yaml";
    }
    run = apply(
      run,
      {
        op: "complete",
        workflowId: definition.id,
        checkpointId: step.id,
        definitionHash: identity(definition).definitionHash,
        receiptKey: step.id,
        evidence: fields,
      },
      definition,
    ).run;
  }
  expect(run.checkpointId).toBeNull();
  expect(run.receipts).toHaveLength(6);
  expect(run.bindings.previewPolicy).toBe("NOT_CONFIGURED");
});
