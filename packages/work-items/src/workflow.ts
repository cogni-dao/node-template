// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/workflow`
 * Purpose: Pure checkpoint selection and receipt transitions for node-owned work.
 * Scope: Validates recorded attestations; never executes or certifies external actions.
 * Invariants: ONE_CHECKPOINT, READ_NEVER_ADVANCES, RECEIPT_REPLAY, SUBJECT_SCOPED.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5300
 * @public
 */
import { canonicalJson } from "./json.js";
import type { WorkItemStatus } from "./types.js";

export interface WorkflowCheckpoint {
  readonly id: string;
  readonly instruction: string;
  readonly sources: readonly string[];
  readonly requiredEvidence: Readonly<Record<string, string>>;
  readonly pending: string;
  readonly retry: string;
  readonly nextLifecycleStatus?: WorkItemStatus;
  readonly capture?: readonly string[];
  readonly checks?: readonly {
    readonly field: string;
    readonly binding: string;
    readonly relation: "equals" | "differs";
  }[];
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly checkpoints: readonly WorkflowCheckpoint[];
  readonly subject: {
    readonly field: string;
    readonly rewindTo: string;
    readonly sealedBy: string;
  };
}
export interface WorkflowIdentity {
  readonly definitionHash: string;
  readonly structureHash: string;
}
export interface WorkflowReceipt {
  readonly key: string;
  readonly digest: string;
  readonly kind: "complete" | "reconcile-head";
  readonly checkpointId: string;
  readonly definitionHash: string;
  readonly evidence: Readonly<Record<string, string>>;
  readonly recordedAt: string;
}
/** One execution per work item. Replacing a native claim never replaces this value. */
export interface WorkflowRun {
  readonly workflowId: string;
  readonly structureHash: string;
  readonly checkpointId: string | null;
  readonly bindings: Readonly<Record<string, string>>;
  readonly receipts: readonly WorkflowReceipt[];
}
export type WorkflowEvent =
  | { readonly op: "start"; readonly workflowId: string }
  | {
      readonly op: "complete";
      readonly workflowId: string;
      readonly checkpointId: string;
      readonly definitionHash: string;
      readonly receiptKey: string;
      readonly evidence: Readonly<Record<string, string>>;
    }
  | {
      readonly op: "reconcile-head";
      readonly workflowId: string;
      readonly definitionHash: string;
      readonly receiptKey: string;
      readonly headSha: string;
    };

export class WorkflowConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkflowConflictError";
  }
}
function refuse(code: string): never {
  throw new WorkflowConflictError(code);
}
const sha = (value: string) => /^[0-9a-f]{40}$/.test(value);

/** The composition root hashes these strings; the neutral domain has no crypto dependency. */
export function workflowFingerprintInputs(definition: WorkflowDefinition) {
  return {
    definition: canonicalJson(definition),
    structure: canonicalJson({
      id: definition.id,
      subject: definition.subject,
      checkpoints: definition.checkpoints.map(
        ({ id, requiredEvidence, nextLifecycleStatus, capture, checks }) => ({
          id,
          requiredEvidence,
          nextLifecycleStatus,
          capture,
          checks,
        })
      ),
    }),
  };
}

/** Select exactly one checkpoint. No writes and no projection of later instructions. */
export function nextWorkflowCheckpoint(
  run: WorkflowRun,
  definition: WorkflowDefinition,
  identity: WorkflowIdentity
) {
  const receipt = run.receipts.at(-1);
  const lastReceipt = receipt
    ? {
        key: receipt.key,
        digest: receipt.digest,
        kind: receipt.kind,
        checkpointId: receipt.checkpointId,
        definitionHash: receipt.definitionHash,
        recordedAt: receipt.recordedAt,
      }
    : null;
  if (
    run.workflowId !== definition.id ||
    run.structureHash !== identity.structureHash
  ) {
    return {
      workflowId: run.workflowId,
      lastReceipt,
      checkpointId: run.checkpointId,
      blocked: "workflow_definition_changed",
    } as const;
  }
  if (run.checkpointId === null)
    return {
      workflowId: run.workflowId,
      lastReceipt,
      checkpointId: null,
      done: true,
    } as const;
  const checkpoint = definition.checkpoints.find(
    (value) => value.id === run.checkpointId
  );
  if (!checkpoint)
    return {
      workflowId: run.workflowId,
      lastReceipt,
      checkpointId: run.checkpointId,
      blocked: "workflow_definition_changed",
    } as const;
  return {
    workflowId: run.workflowId,
    lastReceipt,
    checkpointId: checkpoint.id,
    definitionHash: identity.definitionHash,
    instruction: checkpoint.instruction,
    sources: checkpoint.sources,
    requiredEvidence: checkpoint.requiredEvidence,
    pending: checkpoint.pending,
    retry: checkpoint.retry,
    bindings: run.bindings,
    evidenceAuthority:
      "agent-attested; authoritative action gates remain external",
  };
}

function validateEvidence(
  checkpoint: WorkflowCheckpoint,
  evidence: Readonly<Record<string, string>>,
  bindings: Readonly<Record<string, string>>
) {
  if (
    Object.keys(evidence).some((key) => !(key in checkpoint.requiredEvidence))
  )
    refuse("unexpected_evidence");
  for (const [field, rule] of Object.entries(checkpoint.requiredEvidence)) {
    const value = evidence[field];
    if (typeof value !== "string" || !value.trim() || value.length > 2048)
      refuse(`missing_or_invalid_evidence:${field}`);
    if (rule === "sha" && !sha(value)) refuse(`invalid_sha:${field}`);
    if (rule === "url") {
      try {
        if (new URL(value).protocol !== "https:")
          refuse(`invalid_url:${field}`);
      } catch {
        refuse(`invalid_url:${field}`);
      }
    } else if (!["sha", "string"].includes(rule) && value !== rule)
      refuse(`invalid_verdict:${field}`);
  }
  for (const check of checkpoint.checks ?? []) {
    const expected = bindings[check.binding];
    if (!expected) refuse(`missing_binding:${check.binding}`);
    const equal = evidence[check.field] === expected;
    if (check.relation === "equals" ? !equal : equal)
      refuse(`evidence_mismatch:${check.field}`);
  }
}

/** Caller persists this result with ordinary content authorization and item revision CAS. */
export function transitionWorkflow(
  current: WorkflowRun | undefined,
  event: WorkflowEvent,
  definition: WorkflowDefinition,
  identity: WorkflowIdentity,
  receiptDigest: string,
  recordedAt: string
): { run: WorkflowRun; replayed: boolean; status?: WorkItemStatus } {
  if (event.workflowId !== definition.id) refuse("workflow_not_found");
  if (event.op === "start") {
    if (current) {
      if (
        current.workflowId !== definition.id ||
        current.structureHash !== identity.structureHash
      )
        refuse("workflow_definition_changed");
      return { run: current, replayed: true };
    }
    const first = definition.checkpoints[0];
    if (!first) refuse("workflow_has_no_checkpoints");
    return {
      run: {
        workflowId: definition.id,
        structureHash: identity.structureHash,
        checkpointId: first.id,
        bindings: {},
        receipts: [],
      },
      replayed: false,
    };
  }
  if (!current) refuse("workflow_not_started");
  if (current.workflowId !== definition.id) refuse("workflow_already_bound");
  const old = current.receipts.find(
    (receipt) => receipt.key === event.receiptKey
  );
  if (old) {
    if (old.digest !== receiptDigest) refuse("receipt_key_conflict");
    return { run: current, replayed: true };
  }
  if (!event.receiptKey.trim() || event.receiptKey.length > 160)
    refuse("invalid_receipt_key");
  if (current.structureHash !== identity.structureHash)
    refuse("workflow_definition_changed");
  if (event.definitionHash !== identity.definitionHash)
    refuse("guidance_changed_refresh_required");
  if (current.receipts.length >= 64) refuse("workflow_receipt_limit");
  if (current.checkpointId === null) refuse("workflow_already_complete");
  const index = definition.checkpoints.findIndex(
    (checkpoint) => checkpoint.id === current.checkpointId
  );
  if (index < 0) refuse("workflow_definition_changed");
  const checkpoint = definition.checkpoints[index];
  if (!checkpoint) refuse("workflow_definition_changed");
  let checkpointId: string | null;
  let evidence: Readonly<Record<string, string>>;
  const bindings = { ...current.bindings };
  let status: WorkItemStatus | undefined;
  if (event.op === "reconcile-head") {
    if (!sha(event.headSha)) refuse("invalid_sha:headSha");
    if (!bindings[definition.subject.field]) refuse("subject_not_bound");
    if (bindings[definition.subject.sealedBy])
      refuse("subject_sealed_after_merge");
    if (event.headSha === bindings[definition.subject.field])
      refuse("subject_unchanged");
    const rewind = definition.checkpoints.findIndex(
      (step) => step.id === definition.subject.rewindTo
    );
    if (rewind < 0) refuse("workflow_definition_changed");
    for (const step of definition.checkpoints.slice(rewind))
      for (const key of step.capture ?? []) delete bindings[key];
    bindings[definition.subject.field] = event.headSha;
    checkpointId = definition.subject.rewindTo;
    evidence = { [definition.subject.field]: event.headSha };
    status = definition.checkpoints[rewind - 1]?.nextLifecycleStatus;
  } else {
    if (event.checkpointId !== current.checkpointId) refuse("wrong_checkpoint");
    validateEvidence(checkpoint, event.evidence, bindings);
    for (const key of checkpoint.capture ?? []) {
      const value = event.evidence[key];
      if (!value) refuse(`missing_capture:${key}`);
      bindings[key] = value;
    }
    checkpointId = definition.checkpoints[index + 1]?.id ?? null;
    evidence = event.evidence;
    status = checkpoint.nextLifecycleStatus;
  }
  const receipt: WorkflowReceipt = {
    key: event.receiptKey,
    digest: receiptDigest,
    kind: event.op,
    checkpointId: current.checkpointId,
    definitionHash: event.definitionHash,
    evidence,
    recordedAt,
  };
  return {
    run: {
      ...current,
      checkpointId,
      bindings,
      receipts: [...current.receipts, receipt],
    },
    replayed: false,
    ...(status ? { status } : {}),
  };
}
