// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/payer`
 * Purpose: The run path's payer decisions (story.0038): a run's caller (the subject) is billed to an account other than its own only through a live payer row. A live row is written by
 *   one act only, a signed connect from a trusted home (`connections.ts`: every service principal of the connecting issuer is bound to that issuer's one record).
 * Scope: Pure over one port (`PayerBindingStore`) plus one Postgres adapter. No routes, no logging, no billing: the node asks `payerFor(subject)` and then bills the account it names through
 *   its existing pipeline. `selectRunPayer` and `payerScopeUserFor` are the two pure decisions a node's run path composes.
 * Invariants:
 *   - PAYER_IS_AUTHORIZED: `payerFor` answers only for a row with an approver and no revoke. The approver of a connection-written row is the issuer's own org user (the signed connect).
 *   - NEVER_CACHED: `payerFor` reads the table on every call, so a revoked row refuses the next run.
 *   - A subject is any principal: a human, an agent or a service principal minted from another node's signed assertion.
 *   - 0.10.0 removed the request, decide and revoke functions (`requestPayerBinding`, `decidePayerBinding`, `revokePayerBinding`, `ownersForBinding`) and the store methods behind them: no
 *     person approves a binding any more; the customer node's own signed connect does, and the provider's admin suspends it (`connections.ts`).
 * Side-effects: IO (store reads)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design (PAYER_IS_AUTHORIZED), https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import type { SqlTag } from "./postgres";

/** Persistence port for payer rows. Reads only: the one writer is `connections.ts`. */
export interface PayerBindingStore {
  /** The account a live (approved, unrevoked) row names for this subject, or null. Never cached. */
  payerFor(subjectUserId: string): Promise<string | null>;
}

/** The billing account this subject's runs are charged to, or null (the caller's own account pays). Reads the table every time. */
export function payerFor(payer: PayerBindingStore, subjectUserId: string): Promise<string | null> {
  return payer.payerFor(subjectUserId);
}

/** The lookups the run path composes. `getAccount` reads by id on a service-role path (row-level security would hide an org's account from the subject). */
export interface RunPayerDeps<A extends { readonly id: string; readonly ownerUserId?: string | undefined }> {
  readonly payerFor: (subjectUserId: string) => Promise<string | null>;
  readonly getAccount: (billingAccountId: string) => Promise<A | null>;
}

/**
 * Which account pays for a run: the bound account when the subject's live row names one, else `own`. No row, a revoked row, a row naming the caller's own account and a row naming a
 * vanished account all bill `own`, so a service principal with no credits is refused by the node's preflight. A failed read throws (no run starts on a guessed payer). `bound`
 * says whether the answer is the bound account, for the node's log.
 */
export async function selectRunPayer<A extends { readonly id: string; readonly ownerUserId?: string | undefined }>(
  deps: RunPayerDeps<A>,
  input: { readonly subjectUserId: string; readonly own: A }
): Promise<{ readonly account: A; readonly bound: boolean }> {
  const boundId = await deps.payerFor(input.subjectUserId);
  if (!boundId || boundId === input.own.id) return { account: input.own, bound: false };
  const account = await deps.getAccount(boundId);
  return account ? { account, bound: true } : { account: input.own, bound: false };
}

/**
 * The user whose row-level-security scope reads and charges `billingAccountId` for this run: the actor itself for its own account, the account's owner when the actor's live row names
 * this very account, and the actor otherwise (the unchanged path: any other account stays invisible).
 */
export async function payerScopeUserFor(
  deps: RunPayerDeps<{ readonly id: string; readonly ownerUserId?: string | undefined }>,
  input: { readonly actorUserId: string; readonly billingAccountId: string }
): Promise<string> {
  const account = await deps.getAccount(input.billingAccountId);
  if (!account?.ownerUserId || account.ownerUserId === input.actorUserId) return input.actorUserId;
  return (await deps.payerFor(input.actorUserId)) === input.billingAccountId ? account.ownerUserId : input.actorUserId;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The Postgres adapter over the same injected tagged-template client as `createPostgresAgentGrantsStore`. The client must be a service-role connection (the table has no policy). */
export function createPostgresPayerBindingStore(sql: SqlTag): PayerBindingStore {
  return {
    async payerFor(subjectUserId) {
      // PAYER_IS_AUTHORIZED: an approver and no revoke. Never cached.
      const rows = await sql`
        SELECT billing_account_id FROM payer_bindings
        WHERE subject_user_id = ${subjectUserId} AND approved_by IS NOT NULL AND revoked_at IS NULL LIMIT 1`;
      return str(rows[0]?.billing_account_id);
    },
  };
}
