// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/work.items.artifacts.v1.contract`
 * Purpose: Record and list the immutable review and validation artifacts of a work item (task.0028).
 * Scope: Re-exports the artifact schemas that `@cogni-dao/work-items` owns. Contains no schema or logic of its own.
 * Invariants:
 *   - ONE_ARTIFACT_SHAPE: the write body, the stored row and the item read's `artifacts` part come from one package schema.
 *   - AUTHOR_IS_STAMPED: the body never carries an author; the server stamps the authenticated principal.
 *   - BOUNDED_READ: newest first, at most 50.
 * Side-effects: none
 * Links: hub work-cicd-gates-design
 * @public
 */

import type { z } from "zod";
import {
  WorkItemArtifactInputSchema,
  WorkItemArtifactSchema,
  WorkItemArtifactsLatestSchema,
  workItemsArtifactsCreateOperation,
  workItemsArtifactsListOperation,
} from "@cogni/work-items";

export {
  WorkItemArtifactInputSchema,
  WorkItemArtifactSchema,
  WorkItemArtifactsLatestSchema,
  workItemsArtifactsCreateOperation,
  workItemsArtifactsListOperation,
};

export type WorkItemArtifactInput = z.infer<typeof WorkItemArtifactInputSchema>;
export type WorkItemArtifactDto = z.infer<typeof WorkItemArtifactSchema>;
