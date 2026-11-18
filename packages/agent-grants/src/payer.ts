// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/payer`
 * Purpose: Payer bindings (story.0038 phase 2): a run's caller (the subject) is billed to an account other than its own only through a binding that
 *   the account's owners approved. The binding IS the consent; there is no `account:spend` scope.
 * Scope: Pure over two ports (`PayerBindingStore`, plus `AgentGrantsStore` for the owner check) and one Postgres adapter. No routes, no logging, no billing: the node
 *   asks `payerFor(subject)` and then bills the account it names through its existing pipeline.
 * Invariants:
 *   - PAYER_IS_AUTHORIZED: `payerFor` answers only for a binding with an approver and no revoke. A pending ask names no payer.
 *   - ONE_OPEN_BINDING_PER_SUBJECT: a unique partial index (`revoked_at IS NULL`) allows one pending or live binding per subject. A new ask for another account replaces
 *     a pending one; a live one must be turned Off first (`already_bound`).
 *   - OWNERS_DECIDE: approve, deny and revoke all pass `canApprove` for the binding's account, with `owners(orgSource)` for an org account (read at decision time,
 *     refused on a failed read). NO_SELF_APPROVAL: the subject never decides its own binding. The statement also pins the account to one a person owns or an org owns.
 *   - NEVER_CACHED: `payerFor` reads the table on every call, so Off refuses the next run.
 *   - A subject is any principal: a human, an agent or a service principal minted from another node's signed assertion.
 * Side-effects: IO (store reads and writes)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design (PAYER_IS_AUTHORIZED), https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { type ApprovalCaller, canApprove } from "./approval";
import type { OrgOwners } from "./orgs";
import { AgentRolesError } from "./roles";
import type { AgentGrantsStore } from "./types";
import type { SqlTag } from "./postgres";

/** Open (pending) asks across all subjects. Identities are cheap, so this bounds what a flood of throwaway subjects puts in front of owners. */
export const MAX_PENDING_PAYER_BINDINGS = 100;

export type PayerBindingState = "pending" | "live";

/** One open binding as the store reports it. */
export interface PayerBindingRow {
  readonly id: string;
  readonly subjectUserId: string;
  readonly billingAccountId: string;
  readonly state: PayerBindingState;
}

export type PayerAskResult = "created" | "existing" | "already_bound" | "unknown_account" | "too_many";

/** Persistence port for payer bindings. */
export interface PayerBindingStore {
  /** The subject's one open (pending or live) binding, or null. */
  openFor(subjectUserId: string): Promise<PayerBindingRow | null>;
  /** One binding by id (open only: a closed binding is null). */
  get(id: string): Promise<PayerBindingRow | null>;
  /** The account a live (approved, unrevoked) binding names for this subject, or null. Never cached. */
  payerFor(subjectUserId: string): Promise<string | null>;
  /**
   * The subject asks: one pending row for `billingAccountId`. Replaces the subject's pending row for another account. `existing` = an open row for this very account
   * already exists (pending or live); `already_bound` = a live row for ANOTHER account; `unknown_account` = no such account; `too_many` = the open-ask cap.
   */
  request(input: {
    subjectUserId: string;
    billingAccountId: string;
    maxPendingTotal: number;
  }): Promise<{ result: PayerAskResult; id: string | null }>;
  /** Approves the pending binding. False when none is pending, the approver is the subject, or the account is neither a person's nor an org's. */
  approve(input: { id: string; approvedBy: string }): Promise<boolean>;
  /** Ends a pending (deny) or live (Off) binding. False when none is open. */
  close(input: { id: string; closedBy: string }): Promise<boolean>;
}

export interface PayerAskOutcome {
  readonly id: string;
  readonly state: PayerBindingState;
  readonly created: boolean;
}

/**
 * A subject asks to be billed to `billingAccountId`. Idempotent for the same account. The ask grants nothing: only an owner's decision opens `payerFor`.
 * Throws `AgentRolesError`: `too_many_requests` (the open-ask cap), `not_allowed` (`already_bound`: turn the live binding Off first), `principal_not_found` (no such account).
 */
export async function requestPayerBinding(
  payer: PayerBindingStore,
  input: { subjectUserId: string; billingAccountId: string }
): Promise<PayerAskOutcome> {
  const { result, id } = await payer.request({ ...input, maxPendingTotal: MAX_PENDING_PAYER_BINDINGS });
  if (result === "too_many") throw new AgentRolesError("too_many_requests", "too many open payer requests");
  if (result === "already_bound") throw new AgentRolesError("not_allowed", "a live payer binding must be turned Off before asking for another account");
  if (result === "unknown_account" || !id) throw new AgentRolesError("principal_not_found", "unknown account");
  const open = await payer.get(id);
  return { id, state: open?.state ?? "pending", created: result === "created" };
}

/** Throws unless `me` may decide this binding: never the subject, and an owner of the binding's account (an org's owners through `owners`). */
async function requireOwnerDecision(
  grants: AgentGrantsStore,
  me: ApprovalCaller,
  row: PayerBindingRow,
  owners: OrgOwners | undefined
): Promise<void> {
  if (me.userId === row.subjectUserId) throw new AgentRolesError("self_approval", "a subject cannot decide its own payer binding");
  const allowed = await canApprove(
    grants,
    me,
    { resource: "account", principalUserId: row.subjectUserId, accountId: row.billingAccountId },
    owners
  );
  if (!allowed) throw new AgentRolesError("not_allowed", "only the owner of an account decides who may be billed to it");
}

/**
 * An owner of the account turns a pending binding On (`approve: true`) or dismisses it (`approve: false`). An unknown or closed binding is `decided: false`.
 * Throws `AgentRolesError` `self_approval` or `not_allowed`, and `OwnerSourceUnavailableError` when an org's owners cannot be read (refuses, never allows).
 */
export async function decidePayerBinding(
  payer: PayerBindingStore,
  grants: AgentGrantsStore,
  input: { me: ApprovalCaller; id: string; approve: boolean; owners?: OrgOwners | undefined }
): Promise<{ decided: boolean; subjectUserId?: string; billingAccountId?: string }> {
  const row = await payer.get(input.id);
  if (!row) return { decided: false };
  await requireOwnerDecision(grants, input.me, row, input.owners);
  if (row.state !== "pending") return { decided: false };
  const decided = input.approve
    ? await payer.approve({ id: row.id, approvedBy: input.me.userId })
    : await payer.close({ id: row.id, closedBy: input.me.userId });
  return decided ? { decided, subjectUserId: row.subjectUserId, billingAccountId: row.billingAccountId } : { decided };
}

/** An owner of the account turns a binding Off (pending or live). The subject's next run falls back to its own account. */
export async function revokePayerBinding(
  payer: PayerBindingStore,
  grants: AgentGrantsStore,
  input: { me: ApprovalCaller; id: string; owners?: OrgOwners | undefined }
): Promise<{ revoked: boolean; subjectUserId?: string; billingAccountId?: string }> {
  const row = await payer.get(input.id);
  if (!row) return { revoked: false };
  await requireOwnerDecision(grants, input.me, row, input.owners);
  const revoked = await payer.close({ id: row.id, closedBy: input.me.userId });
  return revoked ? { revoked, subjectUserId: row.subjectUserId, billingAccountId: row.billingAccountId } : { revoked };
}

/** The billing account this subject's runs are charged to, or null (the caller's own account pays). Reads the table every time. */
export function payerFor(payer: PayerBindingStore, subjectUserId: string): Promise<string | null> {
  return payer.payerFor(subjectUserId);
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The Postgres adapter over the same injected tagged-template client as `createPostgresAgentGrantsStore`. The client must be a service-role connection (the table has no policy). */
export function createPostgresPayerBindingStore(sql: SqlTag): PayerBindingStore {
  const toRow = (row: Record<string, unknown> | undefined): PayerBindingRow | null => {
    const id = str(row?.id);
    const subjectUserId = str(row?.subject_user_id);
    const billingAccountId = str(row?.billing_account_id);
    if (!id || !subjectUserId || !billingAccountId) return null;
    return { id, subjectUserId, billingAccountId, state: row?.approved_by ? "live" : "pending" };
  };
  return {
    async openFor(subjectUserId) {
      const rows = await sql`
        SELECT id, subject_user_id, billing_account_id, approved_by FROM payer_bindings
        WHERE subject_user_id = ${subjectUserId} AND revoked_at IS NULL LIMIT 1`;
      return toRow(rows[0]);
    },
    async get(id) {
      const rows = await sql`
        SELECT id, subject_user_id, billing_account_id, approved_by FROM payer_bindings
        WHERE id = ${id} AND revoked_at IS NULL LIMIT 1`;
      return toRow(rows[0]);
    },
    async payerFor(subjectUserId) {
      // PAYER_IS_AUTHORIZED: an approver and no revoke. Never cached.
      const rows = await sql`
        SELECT billing_account_id FROM payer_bindings
        WHERE subject_user_id = ${subjectUserId} AND approved_by IS NOT NULL AND revoked_at IS NULL LIMIT 1`;
      return str(rows[0]?.billing_account_id);
    },
    async request({ subjectUserId, billingAccountId, maxPendingTotal }) {
      const open = await sql`
        SELECT id, billing_account_id, approved_by FROM payer_bindings
        WHERE subject_user_id = ${subjectUserId} AND revoked_at IS NULL LIMIT 1`;
      const current = open[0];
      if (current && current.billing_account_id === billingAccountId) return { result: "existing", id: str(current.id) };
      if (current?.approved_by) return { result: "already_bound", id: null };
      const known = await sql`SELECT 1 AS ok FROM billing_accounts WHERE id = ${billingAccountId} LIMIT 1`;
      if (known.length === 0) return { result: "unknown_account", id: null };
      if (!current) {
        const count = await sql`SELECT count(*)::int AS n FROM payer_bindings WHERE approved_by IS NULL AND revoked_at IS NULL`;
        if (Number(count[0]?.n ?? 0) >= maxPendingTotal) return { result: "too_many", id: null };
      } else {
        // A pending ask for another account is replaced: the subject changed its mind, and the unique index allows one open row.
        await sql`
          UPDATE payer_bindings SET revoked_at = now(), revoked_by = ${subjectUserId}
          WHERE id = ${current.id as string} AND approved_by IS NULL AND revoked_at IS NULL`;
      }
      const inserted = await sql`
        INSERT INTO payer_bindings (subject_user_id, billing_account_id)
        VALUES (${subjectUserId}, ${billingAccountId})
        ON CONFLICT (subject_user_id) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`;
      const id = str(inserted[0]?.id);
      if (id) return { result: "created", id };
      // A concurrent ask took the slot: report it (the same account is `existing`; any other is a lost race the subject can repeat).
      const raced = await sql`
        SELECT id, billing_account_id FROM payer_bindings WHERE subject_user_id = ${subjectUserId} AND revoked_at IS NULL LIMIT 1`;
      return raced[0]?.billing_account_id === billingAccountId
        ? { result: "existing", id: str(raced[0]?.id) }
        : { result: "already_bound", id: null };
    },
    async approve({ id, approvedBy }) {
      // `canApprove` (with the org's owners) already said yes; this statement pins the write: not the subject, a pending row, and an account that a person or an org owns.
      const rows = await sql`
        UPDATE payer_bindings p
        SET approved_by = ${approvedBy}, approved_at = now()
        FROM billing_accounts b
        WHERE p.id = ${id} AND p.approved_by IS NULL AND p.revoked_at IS NULL
          AND p.subject_user_id <> ${approvedBy}
          AND b.id = p.billing_account_id
          AND (b.owner_user_id = ${approvedBy}
               OR EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = b.owner_user_id AND ap.kind = 'org'))
        RETURNING p.id`;
      return rows.length > 0;
    },
    async close({ id, closedBy }) {
      const rows = await sql`
        UPDATE payer_bindings SET revoked_at = now(), revoked_by = ${closedBy}
        WHERE id = ${id} AND revoked_at IS NULL
        RETURNING id`;
      return rows.length > 0;
    },
  };
}
