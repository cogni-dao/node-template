// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/payer-bindings.v1`
 * Purpose: Zod contracts for the payer binding routes (story.0038 phase 2): a caller asks to be billed to an account, an owner of that account turns it On or Off.
 * Scope: Bodies and outputs only. The subject is always the authenticated caller on the ask; the approver is always the authenticated caller on a decision, never a body field.
 * Invariants: CONTRACTS_ARE_TRUTH. PAYER_IS_AUTHORIZED: an ask grants nothing (`pending`); only an owner's decision makes `payerFor` answer. An unknown binding, an unknown account and
 *   a closed or expired binding are indistinguishable where a route says so (non-disclosing): the ask for an unknown account answers like any other, with an id that opens nothing.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { z } from "zod";

export const payerBindingAskOperation = {
  id: "payer-bindings.ask.v1",
  input: z.object({ billingAccountId: z.string().min(1).max(100) }),
  output: z.object({
    id: z.string().uuid(),
    status: z.enum(["pending", "live"]),
  }),
} as const;

export const payerBindingDecisionOperation = {
  id: "payer-bindings.decision.v1",
  /** `approve: true` turns a pending binding On; `approve: false` dismisses it. */
  input: z.object({ approve: z.boolean() }),
  output: z.object({ changed: z.boolean() }),
} as const;

export const payerBindingRevokeOperation = {
  id: "payer-bindings.revoke.v1",
  output: z.object({ changed: z.boolean() }),
} as const;
