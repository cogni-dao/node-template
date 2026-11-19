// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { PENDING_BINDING_TTL_DAYS, type PayerBindingRow, type PayerBindingStore } from "../src";

interface Binding {
  id: string;
  subject: string;
  account: string;
  approvedBy: string | null;
  revoked: boolean;
  revokedBy: string | null;
  /** ms since epoch on the store clock. */
  createdAt: number;
}

/**
 * In-memory payer binding store with the same semantics as the Postgres adapter: one open (pending or live) row per subject, `payerFor` only for an approved and unrevoked
 * row, an approver that is never the subject, and an account that a person (`accounts`: user -> account) or an org (`orgAccounts`) owns.
 */
export function memoryPayerStore(init: {
  /** billing account id -> its owner user id. */
  accounts: Record<string, string>;
  /** billing account ids whose owner user is an org. */
  orgAccounts?: readonly string[];
}): PayerBindingStore & { rows: Binding[]; clock: { now: number } } {
  const clock = { now: Date.now() };
  const ttlMs = PENDING_BINDING_TTL_DAYS * 86_400_000;
  const rows: Binding[] = [];
  let seq = 0;
  const view = (b: Binding): PayerBindingRow => ({
    id: b.id,
    subjectUserId: b.subject,
    billingAccountId: b.account,
    state: b.approvedBy ? "live" : "pending",
  });
  /** A pending ask ends at its expiry; a live binding does not. */
  const expired = (b: Binding) => !b.approvedBy && b.createdAt <= clock.now - ttlMs;
  const open = (subject: string) => rows.find((b) => b.subject === subject && !b.revoked && !expired(b));
  /** The row the unique index sees: expired pending rows still hold the slot until replaced. */
  const slot = (subject: string) => rows.find((b) => b.subject === subject && !b.revoked);
  return {
    rows,
    clock,
    async openFor(subjectUserId) {
      const b = open(subjectUserId);
      return b ? view(b) : null;
    },
    async get(id) {
      const b = rows.find((x) => x.id === id && !x.revoked && !expired(x));
      return b ? view(b) : null;
    },
    async payerFor(subjectUserId) {
      const b = open(subjectUserId);
      return b?.approvedBy ? b.account : null;
    },
    async request({ subjectUserId, billingAccountId, maxPendingPerAccount }) {
      const current = slot(subjectUserId);
      if (current && !expired(current) && current.account === billingAccountId) return { result: "existing", id: current.id };
      if (current?.approvedBy) return { result: "already_bound", id: null };
      if (!(billingAccountId in init.accounts)) return { result: "unknown_account", id: null };
      if (current) {
        current.revoked = true;
        current.revokedBy = subjectUserId;
      }
      if (rows.filter((r) => r.account === billingAccountId && !r.revoked && !r.approvedBy && !expired(r)).length >= maxPendingPerAccount) return { result: "too_many", id: null };
      const row: Binding = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, subject: subjectUserId, account: billingAccountId, approvedBy: null, revoked: false, revokedBy: null, createdAt: clock.now };
      rows.push(row);
      return { result: "created", id: row.id };
    },
    async approve({ id, approvedBy }) {
      const b = rows.find((x) => x.id === id && !x.revoked && !x.approvedBy && !expired(x));
      if (!b || b.subject === approvedBy) return false;
      const owner = init.accounts[b.account];
      if (owner !== approvedBy && !init.orgAccounts?.includes(b.account)) return false;
      b.approvedBy = approvedBy;
      return true;
    },
    async close({ id, closedBy }) {
      const b = rows.find((x) => x.id === id && !x.revoked);
      if (!b) return false;
      b.revoked = true;
      b.revokedBy = closedBy;
      return true;
    },
  };
}

