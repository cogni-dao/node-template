// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/work.items.workflow.v1.contract`
 * Purpose: Creator-authorized checkpoint start, completion and head-reconciliation contract.
 * Scope: HTTP schema only. Does not execute shipping actions.
 * Invariants: EXPECTED_REVISION_REQUIRED, CREATOR_AUTHORIZATION_REQUIRED.
 * Side-effects: none
 * @public
 */
import { z } from "zod";
import { WorkItemDtoSchema } from "./work.items.list.v1.contract";
import { WorkflowEventSchema } from "./work.items.workflow.schema";

export const workItemsWorkflowOperation = {
  id: "work.items.workflow.v1",
  summary: "Record a workflow checkpoint",
  description:
    "Starts or advances one node-owned checkpoint under creator authorization and revision CAS; never dispatches external actions. Evidence is recorded as an attestation.",
  input: z.strictObject({
    id: z.string().regex(/^(task|bug|story|spike|subtask)\.\d+$/),
    expectedRevision: z.number().int().nonnegative(),
    runId: z.string().min(1).max(160).optional(),
    event: WorkflowEventSchema,
  }),
  output: z.object({ item: WorkItemDtoSchema, replayed: z.boolean() }),
} as const;
export type WorkItemsWorkflowInput = z.infer<
  typeof workItemsWorkflowOperation.input
>;
