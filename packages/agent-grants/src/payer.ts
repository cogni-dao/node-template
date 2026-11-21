// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/payer`
 * Purpose: The payer resolver: which billing account pays for a run. A run's caller (the subject) is billed to an account other than its own only through an APPROVED
 *   `payer_bindings` row, and since 0.10.0 only a node link writes one (`./org-links`): the org's owner made the code, the other node signed, and the link bound each of that
 *   node's service principals to the org's account. Nothing else picks a payer (ONE_PAYER_PATH).
 * Scope: One read over a service-role tag plus the two pure decisions a node's run path composes (`selectRunPayer`, `payerScopeUserFor`). No routes, no logging, no money: the
 *   node asks `payerFor(subject)` and bills the account it names through its own pipeline. Identity picks the account and stops (IDENTITY_PICKS_ACCOUNT, BILLING_CHARGES).
 * Invariants:
 *   - PAYER_IS_AUTHORIZED: `payerFor` answers only for a binding with an approver, no revoke, and a LINK that wrote it (`link_id` set). A binding with no link (the retired ask and
 *     approve flow wrote such rows) bills nothing: only a link is a payer path.
 *   - NEVER_CACHED: `payerFor` reads the table on every call, so an unlink, a suspension or a revoke refuses the very next run.
 *   - ORG_SUSPENDED: a live binding to an org the node's admin suspended is refused with `PayerRefusedError("org_suspended")`, never billed to the caller's own account.
 *   - ORG_LINK_CLOSED: a binding whose link is closed is refused with `PayerRefusedError("org_link_closed")`, live or revoked: a live binding under a closed link can only be a bind that
 *     raced the close, and it must not bill. A subject that never had a link binding is unchanged: no binding means its own account pays.
 *   - A subject is any principal: a person, an agent or a service principal minted from another node's signed assertion.
 *   - The ask, decide and revoke functions and the `POST /api/v1/payer-bindings` routes are gone (0.10.0): a binding exists only because an org link wrote it.
 * Side-effects: IO (one store read)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle, https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import type { SqlTag } from "./postgres";

export type PayerRefusal = "org_suspended" | "org_link_closed";

/** A run is refused because of where its payer binding points. The node answers 403 with the code; the caller is never silently billed elsewhere. */
export class PayerRefusedError extends Error {
  readonly code: PayerRefusal;
  constructor(code: PayerRefusal) {
    super(code);
    this.name = "PayerRefusedError";
    this.code = code;
  }
}

/** True for a `PayerRefusedError`, also across a duplicated copy of the package. */
export const isPayerRefusedError = (error: unknown): error is PayerRefusedError =>
  error instanceof PayerRefusedError ||
  (error instanceof Error && error.name === "PayerRefusedError" && ((error as { code?: unknown }).code === "org_suspended" || (error as { code?: unknown }).code === "org_link_closed"));

/** Persistence port of the payer resolver. */
export interface PayerBindingStore {
  /**
   * The account a live (approved, unrevoked) binding names for this subject, or null. Throws `PayerRefusedError` for a live binding to a suspended org and for a subject whose
   * latest binding came from a link that is now closed. Never cached.
   */
  payerFor(subjectUserId: string): Promise<string | null>;
}

/** The billing account this subject's runs are charged to, or null (the caller's own account pays). Reads the table every time. May throw `PayerRefusedError`. */
export function payerFor(payer: PayerBindingStore, subjectUserId: string): Promise<string | null> {
  return payer.payerFor(subjectUserId);
}

/** The lookups the run path composes. `getAccount` reads by id on a service-role path (row-level security would hide an org's account from the subject). */
export interface RunPayerDeps<A extends { readonly id: string; readonly ownerUserId?: string | undefined }> {
  readonly payerFor: (subjectUserId: string) => Promise<string | null>;
  readonly getAccount: (billingAccountId: string) => Promise<A | null>;
}

/**
 * Which account pays for a run: the bound account when the subject's live binding names one, else `own`. No binding, a revoked binding that no link wrote, a binding to the caller's own
 * account and a binding to a vanished account all bill `own`. A suspended org and a closed link throw `PayerRefusedError` (no run starts); a failed binding read throws (no run starts on a
 * guessed payer). `bound` says whether the answer is the bound account, for the node's log.
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
 * The user whose row-level-security scope reads and charges `billingAccountId` for this run: the actor itself for its own account, the account's owner when the actor's live binding names
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

/** The Postgres adapter over a service-role tag (`payer_bindings` has no policy). */
export function createPostgresPayerBindingStore(sql: SqlTag): PayerBindingStore {
  return {
    async payerFor(subjectUserId) {
      // A live binding decides (the unique index allows one); else the latest revoked one: a revoked binding that a link wrote and whose link is closed is a refusal.
      const rows = await sql`
        SELECT b.billing_account_id, b.approved_by, b.revoked_at, b.link_id, l.closed_at AS link_closed_at, p.suspended_at
        FROM payer_bindings b
        LEFT JOIN org_links l ON l.id = b.link_id
        LEFT JOIN billing_accounts a ON a.id = b.billing_account_id
        LEFT JOIN agent_principals p ON p.user_id = a.owner_user_id AND p.kind = 'org'
        WHERE b.subject_user_id = ${subjectUserId} AND b.approved_by IS NOT NULL AND b.link_id IS NOT NULL
        ORDER BY (b.revoked_at IS NULL) DESC, b.created_at DESC, b.id DESC
        LIMIT 1`;
      const row = rows[0];
      if (!row) return null;
      const live = row.revoked_at === null || row.revoked_at === undefined;
      const linkClosed = row.link_closed_at !== null && row.link_closed_at !== undefined;
      if (live) {
        // A live binding under a closed link (a bind that raced the close) never bills.
        if (linkClosed) throw new PayerRefusedError("org_link_closed");
        if (row.suspended_at !== null && row.suspended_at !== undefined) throw new PayerRefusedError("org_suspended");
        return str(row.billing_account_id);
      }
      if (linkClosed) throw new PayerRefusedError("org_link_closed");
      return null;
    },
  };
}
