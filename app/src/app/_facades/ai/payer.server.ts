// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/ai/payer.server`
 * Purpose: Which billing account pays for a run (story.0038 phase 2). A caller with a live payer binding is billed to the account its owners approved; every other caller is billed
 *   to its own account, unchanged.
 * Scope: Two small decisions over injected lookups: `selectRunPayer` (at run request) and `payerScopeUserFor` (at run execution, to read the bound account under row-level security).
 *   The binding rules live in `@cogni-dao/agent-grants`; this file only asks `payerFor` and bills what it names.
 * Invariants:
 *   - PAYER_IS_AUTHORIZED: only a live binding moves the charge. No binding, a revoked binding, or a binding to a vanished account bills the caller's own account, so a service
 *     principal with no credits is refused by the existing preflight ("Off refuses the next run").
 *   - NEVER_CACHED: `payerFor` is read on every run request and every run start; Off takes effect on the next run.
 *   - FAIL_CLOSED_ON_OUTAGE: a failed binding read throws (the run is not started) rather than guessing a payer.
 *   - OWNER_SCOPED_READ: the bound account belongs to its owner (an org's user), so RLS hides it from the caller; the run reads and charges it in the OWNER's scope, and only when the caller's
 *     live binding names exactly that account.
 * Side-effects: logs `payer.selected` (subject, billingAccountId); no token or balance
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";

interface AccountLike {
  readonly id: string;
  readonly ownerUserId?: string;
}

export interface PayerDeps<A extends AccountLike> {
  /** The account a live binding names for this subject, or null. */
  readonly payerFor: (subjectUserId: string) => Promise<string | null>;
  /** Read by id on the service-role path (RLS would hide an org's account from the subject). */
  readonly getBillingAccountById: (billingAccountId: string) => Promise<A | null>;
  readonly log: Pick<Logger, "info">;
}

/** The account that pays for this caller's run: the bound account when a live binding names one, else `own`. */
export async function selectRunPayer<A extends AccountLike>(
  deps: PayerDeps<A>,
  input: { readonly subjectUserId: string; readonly own: A }
): Promise<A> {
  const boundId = await deps.payerFor(input.subjectUserId);
  if (!boundId || boundId === input.own.id) return input.own;
  const bound = await deps.getBillingAccountById(boundId);
  if (!bound) return input.own;
  deps.log.info(
    { event: EVENT_NAMES.PAYER_SELECTED, subject: input.subjectUserId, billingAccountId: bound.id },
    EVENT_NAMES.PAYER_SELECTED
  );
  return bound;
}

/**
 * The user whose row-level-security scope reads and charges `billingAccountId` for this run: the actor itself for its own account, the account's owner when the actor's live binding names
 * this very account, and the actor otherwise (the unchanged path: any other account stays invisible).
 */
export async function payerScopeUserFor(
  deps: Pick<PayerDeps<AccountLike>, "payerFor" | "getBillingAccountById">,
  input: { readonly actorUserId: string; readonly billingAccountId: string }
): Promise<string> {
  const account = await deps.getBillingAccountById(input.billingAccountId);
  if (!account?.ownerUserId || account.ownerUserId === input.actorUserId) return input.actorUserId;
  return (await deps.payerFor(input.actorUserId)) === input.billingAccountId ? account.ownerUserId : input.actorUserId;
}
