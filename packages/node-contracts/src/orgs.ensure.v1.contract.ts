// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/orgs.ensure.v1`
 * Purpose: Zod contract for POST /api/v1/orgs (story.0038): register an org for an owner source and read back its principal and its one billing account.
 * Scope: Body and output only. The `repo-spec` source names the org's repository by its canonical https GitHub URL; its owners are read from the default branch's
 *   repo-spec (`activity_ledger.approvers`) whenever an owner decision is made, never copied into a table.
 * Invariants: CONTRACTS_ARE_TRUTH. Registration grants nothing (REGISTRATION_GRANTS_NOTHING): it is idempotent per source and gives the caller no authority.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { z } from "zod";

export const ensureOrgOperation = {
  id: "orgs.ensure.v1",
  input: z.object({
    source: z.object({
      kind: z.literal("repo-spec"),
      ref: z.string().min(1).max(200),
      /** Where the repo-spec lives in the repo; default `.cogni/repo-spec.yaml`. A monorepo node names `nodes/<node>/.cogni/repo-spec.yaml`. */
      path: z.string().min(1).max(200).optional(),
    }),
  }),
  output: z.object({
    orgUserId: z.string().min(1),
    billingAccountId: z.string().min(1),
  }),
} as const;
