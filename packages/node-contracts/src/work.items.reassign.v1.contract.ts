// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/work.items.reassign.v1.contract`
 * Purpose: Operation contract for a node admin moving every work item created by one principal to another.
 * Scope: Provides Zod schema and types for the reassign wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - SESSION_ADMIN_ONLY: callers are node-admin browser sessions; agent bearer keys are rejected by the route.
 *   - Both principals are UUIDs and differ; `to` must be an existing user.
 *   - dryRun lists the matching ids and writes nothing.
 * Side-effects: none
 * Links: /api/v1/work/items/reassign route, https://node-template.cognidao.org/work/items/bug.0013
 * @internal
 */

import { z } from "zod";

export const workItemsReassignOperation = {
  id: "work.items.reassign.v1",
  summary: "Reassign work items to a new creator principal",
  description:
    "Node admin only (browser session). Moves created_by_principal_id from one principal to another for every matching work item in one write, e.g. after an agent is re-keyed. dryRun previews the ids.",
  input: z
    .object({
      fromPrincipalId: z.guid(),
      toPrincipalId: z.guid(),
      dryRun: z.boolean().optional(),
    })
    .strict()
    .refine((value) => value.fromPrincipalId !== value.toPrincipalId, {
      message: "fromPrincipalId must differ from toPrincipalId",
      path: ["toPrincipalId"],
    }),
  output: z.object({
    fromPrincipalId: z.string(),
    toPrincipalId: z.string(),
    dryRun: z.boolean(),
    count: z.number().int().nonnegative(),
    ids: z.array(z.string()),
  }),
} as const;

export type WorkItemsReassignInput = z.infer<
  typeof workItemsReassignOperation.input
>;
export type WorkItemsReassignOutput = z.infer<
  typeof workItemsReassignOperation.output
>;
