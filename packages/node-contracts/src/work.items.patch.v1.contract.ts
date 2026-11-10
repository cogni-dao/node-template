// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work.items.patch.v1.contract`
 * Purpose: Operation contract for patching a work item via the operator API.
 * Scope: Provides Zod schema and types for work item patch wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - PATCH_ALLOWLIST: only fields in `set` are mutable. id/created_at/updated_at are server-managed.
 *   - Optional expectedRevision enables compare-and-set; omission preserves unconditional patches.
 *   - Optional reason is one line (CR/LF become spaces), 1-512 chars, stored in Dolt history, never in the item (task.0052).
 *   - No transition state-machine — whoever holds a valid token is trusted.
 * Side-effects: none
 * Links: /api/v1/work/items/[id] route, docs/spec/work-items-port.md, work/items/task.0423.doltgres-work-items-source-of-truth.md
 * @internal
 */

import { WorkItemPatchInputSchema } from "@cogni/work-items";
import type { z } from "zod";

import { WorkItemDtoSchema } from "./work.items.list.v1.contract";

export const workItemsPatchOperation = {
  id: "work.items.patch.v1",
  summary: "Patch a work item",
  description:
    "Updates whitelisted fields on a work item. Optional expectedRevision makes the patch compare-and-set; a stale revision returns 409 without writing. Optional reason (one line, 1-512 chars) says why; it is stored in history (GET /work/items/{id}/history), not in the item.",
  // One schema for the route and the agent tool (core__work_item_update); it lives in @cogni-dao/work-items.
  input: WorkItemPatchInputSchema,
  output: WorkItemDtoSchema,
} as const;

// Export inferred types
export type WorkItemsPatchInput = z.infer<typeof workItemsPatchOperation.input>;
export type WorkItemsPatchOutput = z.infer<
  typeof workItemsPatchOperation.output
>;
