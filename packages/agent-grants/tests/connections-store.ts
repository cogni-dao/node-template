// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { type ConnectionRecord, type ConnectionStanding, type ConnectionStore, MAX_SEQ_STEP } from "../src";

interface Row {
  record: ConnectionRecord;
  balance: number;
  debits: number;
  lastCallAt: string | null;
}

/**
 * In-memory connection store with the same semantics as the Postgres adapter: one record per issuer, `seq` must rise, a disconnect keeps the cap, `suspended` is written only by
 * `setSuspended`, and every bound service principal names the record's account. Money is set by the test (`credit`, `debit`), as the node's ledger would.
 */
export function memoryConnectionStore(): ConnectionStore & {
  rows: Map<string, Row>;
  bound: Map<string, string>;
  /** `<issuer>#<service>` keys of service principals that already exist (they asked); a connect binds only these and creates none. */
  principals: Set<string>;
  credit(orgUserId: string, credits: number): void;
  debit(orgUserId: string, credits: number): void;
} {
  const rows = new Map<string, Row>();
  const bound = new Map<string, string>();
  const principals = new Set<string>();
  const byIssuer = (issuer: string) => [...rows.values()].find((r) => r.record.issuer === issuer);
  const standing = (row: Row): ConnectionStanding => ({ ...row.record, balance: row.balance, debits: row.debits, lastCallAt: row.lastCallAt });
  return {
    rows,
    bound,
    principals,
    credit: (orgUserId, credits) => {
      const row = rows.get(orgUserId);
      if (row) row.balance += credits;
    },
    debit: (orgUserId, credits) => {
      const row = rows.get(orgUserId);
      if (!row) return;
      row.balance -= credits;
      row.debits += credits;
      row.lastCallAt = "2026-11-18T00:00:00.000Z";
    },
    async apply({ issuer, claims, services }) {
      const found = byIssuer(issuer);
      const orgUserId = found?.record.orgUserId ?? `org-${rows.size + 1}`;
      if (!found && claims.seq > MAX_SEQ_STEP) return { ok: false, code: "seq_jump", seq: 0 };
      if (found && found.record.seq >= claims.seq) return { ok: false, code: "stale_seq", seq: found.record.seq };
      if (found && claims.seq - found.record.seq > MAX_SEQ_STEP) return { ok: false, code: "seq_jump", seq: found.record.seq };
      const record: ConnectionRecord = {
        orgUserId,
        billingAccountId: found?.record.billingAccountId ?? `acct-${orgUserId}`,
        issuer,
        status: claims.act === "connect" ? "connected" : "disconnected",
        suspended: found?.record.suspended ?? false,
        cap: claims.act === "connect" ? claims.cap : (found?.record.cap ?? claims.cap),
        seq: claims.seq,
      };
      rows.set(orgUserId, { record, balance: found?.balance ?? 0, debits: found?.debits ?? 0, lastCallAt: found?.lastCallAt ?? null });
      if (claims.act === "connect") for (const service of services) if (principals.has(`${issuer}#${service}`)) bound.set(`${issuer}#${service}`, record.billingAccountId);
      return { ok: true, record };
    },
    async get(orgUserId) {
      return rows.get(orgUserId)?.record ?? null;
    },
    async standingOf(billingAccountId) {
      const row = [...rows.values()].find((r) => r.record.billingAccountId === billingAccountId);
      return row ? standing(row) : null;
    },
    async list({ limit, after }) {
      return [...rows.values()]
        .filter((r) => r.record.issuer > (after ?? ""))
        .sort((a, b) => (a.record.issuer < b.record.issuer ? -1 : 1))
        .slice(0, limit + 1)
        .map(standing);
    },
    async setSuspended(orgUserId, suspended) {
      const row = rows.get(orgUserId);
      if (!row) return false;
      row.record = { ...row.record, suspended };
      return true;
    },
    async bindService({ issuer, subjectUserId }) {
      const row = byIssuer(issuer);
      if (!row) return false;
      bound.set(subjectUserId, row.record.billingAccountId);
      return true;
    },
  };
}
