// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared HTTP/tool projection; no container, IO, authorization or progression. */
import { createHash } from "node:crypto";
import { NextCheckpointSchema } from "@cogni/node-contracts";
import {
  CICD_WORKFLOW,
  CICD_WORKFLOWS,
  nextWorkflowCheckpoint,
  workflowFingerprintInputs,
  type WorkItem,
} from "@cogni/work-items";

const fingerprint = workflowFingerprintInputs(CICD_WORKFLOW);
export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const workflowIdentity = {
  definitionHash: sha256(fingerprint.definition),
  structureHash: sha256(fingerprint.structure),
};
export function workflowProfile(id: string) {
  const definition = CICD_WORKFLOWS.find((entry) => entry.id === id);
  if (!definition) return undefined;
  const inputs = workflowFingerprintInputs(definition);
  return {
    definition,
    identity: {
      definitionHash: sha256(inputs.definition),
      structureHash: sha256(inputs.structure),
    },
  };
}
export function checkpointFor(item: WorkItem) {
  if (!item.workflowRun) return undefined;
  const profile = workflowProfile(item.workflowRun.workflowId);
  const packet = nextWorkflowCheckpoint(
    item.workflowRun,
    profile?.definition ?? CICD_WORKFLOW,
    profile?.identity ?? workflowIdentity
  );
  const path = `/api/v1/work/items/${item.id}`;
  const nextOperation =
    "instruction" in packet
      ? {
          method: "POST" as const,
          path: `${path}/workflow`,
          body: {
            expectedRevision: item.revision,
            event: {
              op: "complete" as const,
              workflowId: packet.workflowId,
              checkpointId: packet.checkpointId,
              definitionHash: packet.definitionHash,
            },
          },
          requires: ["event.receiptKey", "event.evidence"],
        }
      : { method: "GET" as const, path: `${path}/coordination`, requires: [] };
  return NextCheckpointSchema.parse({
    ...packet,
    expectedRevision: item.revision,
    nextOperation,
  });
}
