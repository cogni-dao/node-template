// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/work.items.workflow.schema`
 * Purpose: Wire shapes for durable checkpoint state and one-stage guidance packets.
 * Scope: Zod schemas only; no runtime dependencies or action certification.
 * Invariants: BOUNDED_RECEIPTS, ONE_CHECKPOINT, VALIDATE_IO.
 * Side-effects: none
 * @public
 */
import { z } from "zod";

export const WorkflowEvidenceSchema = z
  .record(z.string().min(1).max(80), z.string().min(1).max(2048))
  .refine(
    (value) => Object.keys(value).length <= 32,
    "Too many evidence fields",
  );
export const WorkflowReceiptSchema = z.object({
  key: z.string().min(1).max(160),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["complete", "reconcile-head"]),
  checkpointId: z.string().min(1).max(80),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: WorkflowEvidenceSchema,
  recordedAt: z.string().datetime(),
});
export const WorkflowRunSchema = z.object({
  workflowId: z.string().min(1).max(80),
  structureHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkpointId: z.string().min(1).max(80).nullable(),
  bindings: WorkflowEvidenceSchema,
  receipts: z.array(WorkflowReceiptSchema).max(64),
});

const PacketBase = z.object({
  workflowId: z.string(),
  checkpointId: z.string().nullable(),
  expectedRevision: z.number().int().nonnegative(),
  lastReceipt: WorkflowReceiptSchema.omit({ evidence: true }).nullable(),
  nextOperation: z.object({
    method: z.enum(["GET", "POST"]),
    path: z.string().max(200),
    body: z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        event: z.object({
          op: z.literal("complete"),
          workflowId: z.string(),
          checkpointId: z.string(),
          definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      })
      .optional(),
    requires: z.array(z.string().max(80)).max(8),
  }),
});
export const NextCheckpointSchema = z.union([
  PacketBase.extend({ blocked: z.string() }),
  PacketBase.extend({ done: z.literal(true) }),
  PacketBase.extend({
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    instruction: z.string().min(1).max(12000),
    sources: z.array(z.string().max(2048)).max(12),
    requiredEvidence: z.record(z.string(), z.string()),
    pending: z.string(),
    retry: z.string(),
    bindings: WorkflowEvidenceSchema,
    evidenceAuthority: z.string(),
  }),
]);

export const WorkflowEventSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("start"),
    workflowId: z.string().min(1).max(80),
  }),
  z.strictObject({
    op: z.literal("complete"),
    workflowId: z.string().min(1).max(80),
    checkpointId: z.string().min(1).max(80),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    receiptKey: z.string().min(1).max(160),
    evidence: WorkflowEvidenceSchema,
  }),
  z.strictObject({
    op: z.literal("reconcile-head"),
    workflowId: z.string().min(1).max(80),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    receiptKey: z.string().min(1).max(160),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
  }),
]);
