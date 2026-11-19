// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/connections`
 * Purpose: Connect from home (story.0038, 0.9.0). A customer node's admin connects from its own Admin page; its node signs ONE assertion as service `node-connect` whose claims carry
 *   `act` (`connect` | `disconnect`), `cap` (integer credits) and a rising `seq`. The provider keeps one thin customer record per signing issuer (an `org` principal of source kind `issuer`
 *   with one ordinary billing account) and one live row of connection state (`org_connections`: status, suspended, cap, seq). The provider's admin funds the record (an allowance, a
 *   credit-ledger row) and may suspend it. A run billed to the record is admitted only while the allowance is left AND the customer's cap is not reached.
 * Scope: Pure decisions over one port (`ConnectionStore`) plus one Postgres adapter (a service-role tag; `apply` needs a transaction). No routes, no logging, no billing writes: the node
 *   verifies the assertion (`./service-auth`), calls `applyConnection`, and writes the allowance through its own accounts adapter.
 * Invariants:
 *   - TRUSTED_SIGNER_ONLY: `applyConnection` takes a VERIFIED assertion of service `node-connect` (the node's verifier already refused an unlisted issuer, an unlisted service, a bad key,
 *     a stale window and a replayed `jti`); an assertion of any other service or without the connect scope is refused here too.
 *   - CONNECT_IS_ORDERED: a connect or disconnect whose `seq` is at or below the stored one is refused (`stale_seq`) and changes nothing; the check and the write are ONE statement.
 *   - A_REPLAY_CHANGES_NOTHING: the same signed body replays as a refused `jti` (durable store) or, with a fresh `jti`, as a stale `seq`; either way the cap is unchanged.
 *   - SUSPEND_IS_STICKY: `suspended` is its own column, written only by `setSuspended` (the provider admin); a connect or a disconnect never writes it, so a customer cannot un-suspend itself.
 *   - ONE_RECORD_PER_ISSUER: every (issuer, service) service principal of the issuer is bound (`payer_bindings`, approved by the record's own org user) to the issuer's one record, so the
 *     ordinary `payerFor` / `selectRunPayer` path bills it.
 *   - ALLOWANCE_BOUNDS_COST: `decideConnection` admits a run only while `balance > 0` AND `debits < cap`; the allowance is the credit balance of the record's billing account (the provider's
 *     own grant); the cap can only lower that. A new connect replaces the cap and keeps the cumulative debits (the sum of the account's charge receipts).
 *   - A refusal is a plain code: `connection_suspended`, `connection_disconnected`, `connection_allowance_empty`, `connection_cap_reached`.
 *   - NO_DATE_PARAMETERS: no JS Date is passed as a parameter.
 * Side-effects: IO (SQL)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { ensureOrg } from "./orgs";
import type { SqlTag } from "./postgres";
import { ensureServicePrincipal, NODE_CONNECT_SERVICE, type VerifiedServiceAssertion } from "./service-auth";

/** The scope the signed connect carries. It is a claim of the assertion, never a grant row. */
export const CONNECT_SCOPE = "connection:write";

/** Rows one list read returns at most; the default when a caller names none. */
export const MAX_CONNECTION_ROWS = 100;
export const DEFAULT_CONNECTION_ROWS = 50;

export type ConnectAct = "connect" | "disconnect";

/** The signed claims of a connect, checked. */
export interface ConnectClaims {
  readonly act: ConnectAct;
  /** Integer credits the customer lets the provider spend for it, at most. */
  readonly cap: number;
  /** A rising integer, at least 1. */
  readonly seq: number;
}

/** The connect claims of a verified assertion, or null when `act`, `cap` or `seq` is missing, mistyped or out of range. */
export function parseConnectClaims(claims: VerifiedServiceAssertion["claims"]): ConnectClaims | null {
  const { act, cap, seq } = claims;
  if (act !== "connect" && act !== "disconnect") return null;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 0) return null;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
  return { act, cap, seq };
}

/** What the customer's own state says it asked for. Suspended is the provider's flag and lives apart from it. */
export type ConnectionStatus = "connected" | "disconnected";

/** One connection record as the store reports it. */
export interface ConnectionRecord {
  readonly orgUserId: string;
  readonly billingAccountId: string;
  readonly issuer: string;
  readonly status: ConnectionStatus;
  /** The provider admin's Suspend. Sticky: only `setSuspended` writes it. */
  readonly suspended: boolean;
  readonly cap: number;
  readonly seq: number;
}

/** A record with its money, for the gate and the provider's page. */
export interface ConnectionStanding extends ConnectionRecord {
  /** Credit balance of the record's billing account: the allowance left. */
  readonly balance: number;
  /** Cumulative credits debited by runs (the sum of the account's charge receipts). */
  readonly debits: number;
  /** When the last run was billed, or null. */
  readonly lastCallAt: string | null;
}

/** What a page shows: the record's standing with one display status (suspended wins). */
export interface ConnectionView {
  readonly orgUserId: string;
  readonly issuer: string;
  readonly status: "connected" | "suspended" | "disconnected";
  readonly allowance: number;
  readonly debits: number;
  readonly cap: number;
  readonly lastCallAt: string | null;
}

export const viewOf = (row: ConnectionStanding): ConnectionView => ({
  orgUserId: row.orgUserId,
  issuer: row.issuer,
  status: row.suspended ? "suspended" : row.status,
  allowance: row.balance,
  debits: row.debits,
  cap: row.cap,
  lastCallAt: row.lastCallAt,
});

export type ConnectionRefusal = "connection_suspended" | "connection_disconnected" | "connection_allowance_empty" | "connection_cap_reached";

/** The one pure gate: why a run billed to this record is refused, or null when it is admitted. Suspended wins, then disconnected, then an empty allowance, then the cap. */
export function decideConnection(row: Pick<ConnectionStanding, "status" | "suspended" | "cap" | "balance" | "debits">): ConnectionRefusal | null {
  if (row.suspended) return "connection_suspended";
  if (row.status !== "connected") return "connection_disconnected";
  if (!(row.balance > 0)) return "connection_allowance_empty";
  if (!(row.debits < row.cap)) return "connection_cap_reached";
  return null;
}

/** A run was refused by the connection gate. `code` is the plain error code. Matched by name as well as identity (published packages may bundle their own copy). */
export class ConnectionRefusedError extends Error {
  readonly code: ConnectionRefusal;
  constructor(code: ConnectionRefusal) {
    super(code);
    this.name = "ConnectionRefusedError";
    this.code = code;
  }
}

const REFUSALS: ReadonlySet<string> = new Set(["connection_suspended", "connection_disconnected", "connection_allowance_empty", "connection_cap_reached"]);

export function isConnectionRefusedError(error: unknown): error is ConnectionRefusedError {
  return error instanceof Error && error.name === "ConnectionRefusedError" && REFUSALS.has((error as { code?: unknown }).code as string);
}

/** Persistence port for connection records. */
export interface ConnectionStore {
  /**
   * Apply a verified connect or disconnect for `issuer` in one transaction: create the issuer's org and record if absent, write the state only when `seq` is above the stored one
   * (else `stale_seq`, nothing written), never touch `suspended`, and on `connect` bind every service principal of `services` to the record. A disconnect keeps the stored cap.
   */
  apply(input: { issuer: string; claims: ConnectClaims; services: readonly string[] }): Promise<{ ok: true; record: ConnectionRecord } | { ok: false; code: "stale_seq"; seq: number }>;
  /** The record of an org user, or null. */
  get(orgUserId: string): Promise<ConnectionRecord | null>;
  /** The standing of the record whose billing account is `billingAccountId`, or null when that account is not a connection record (an ordinary payer). Never cached. */
  standingOf(billingAccountId: string): Promise<ConnectionStanding | null>;
  /** Records ordered by issuer, after `after` (an issuer), at most `limit + 1` (the extra row says there is more). */
  list(input: { limit: number; after: string | null }): Promise<ConnectionStanding[]>;
  /** The provider admin's Suspend or Resume. False when the org user has no record. */
  setSuspended(orgUserId: string, suspended: boolean): Promise<boolean>;
  /** Bind one service principal of `issuer` to its record (used when a service asks after the connect). False when the issuer has no record. */
  bindService(input: { issuer: string; subjectUserId: string }): Promise<boolean>;
}

export type ConnectRefusal = "wrong_service" | "wrong_scope" | "invalid_claims" | "stale_seq";

export type ConnectOutcome =
  | { readonly ok: true; readonly record: ConnectionRecord; readonly act: ConnectAct }
  /** `seq` is the STORED seq, present only on `stale_seq` (the signer is the record's own customer, so it may learn it and rise above it). */
  | { readonly ok: false; readonly code: ConnectRefusal; readonly seq?: number };

/**
 * Applies a VERIFIED assertion as a connect or disconnect. The assertion must be service `node-connect` with the connect scope and well-formed claims; `services` are the services the
 * provider's own trusted-homes entry lists for the issuer (its `node-connect` entry is not a run principal and is skipped). Throws only on a store failure (the node answers 503).
 */
export async function applyConnection(
  store: ConnectionStore,
  input: { assertion: VerifiedServiceAssertion; services: readonly string[] }
): Promise<ConnectOutcome> {
  const { assertion } = input;
  if (assertion.service !== NODE_CONNECT_SERVICE) return { ok: false, code: "wrong_service" };
  if (!assertion.scope.split(" ").includes(CONNECT_SCOPE)) return { ok: false, code: "wrong_scope" };
  const claims = parseConnectClaims(assertion.claims);
  if (!claims) return { ok: false, code: "invalid_claims" };
  const result = await store.apply({ issuer: assertion.issuer, claims, services: input.services.filter((s) => s !== NODE_CONNECT_SERVICE) });
  return result.ok ? { ok: true, record: result.record, act: claims.act } : result;
}

/** The refusal for a run billed to `billingAccountId`, or null (an ordinary payer, or a record that admits it). Reads the live standing every call. */
export async function connectionRefusalFor(store: Pick<ConnectionStore, "standingOf">, billingAccountId: string): Promise<ConnectionRefusal | null> {
  const standing = await store.standingOf(billingAccountId);
  return standing ? decideConnection(standing) : null;
}

/** Throws `ConnectionRefusedError` when a run billed to `billingAccountId` is refused; returns when it is admitted or the account is not a connection record. */
export async function assertConnectionAdmits(store: Pick<ConnectionStore, "standingOf">, billingAccountId: string): Promise<void> {
  const refusal = await connectionRefusalFor(store, billingAccountId);
  if (refusal) throw new ConnectionRefusedError(refusal);
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};
const iso = (value: unknown): string | null => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

const toRecord = (row: Record<string, unknown> | undefined): ConnectionRecord | null => {
  const orgUserId = str(row?.org_user_id);
  const billingAccountId = str(row?.billing_account_id);
  const issuer = str(row?.issuer);
  const status = row?.status === "connected" || row?.status === "disconnected" ? row.status : null;
  if (!orgUserId || !billingAccountId || !issuer || !status) return null;
  return { orgUserId, billingAccountId, issuer, status, suspended: row?.suspended === true, cap: num(row?.cap), seq: num(row?.seq) };
};

const toStanding = (row: Record<string, unknown>): ConnectionStanding | null => {
  const record = toRecord(row);
  return record ? { ...record, balance: num(row.balance), debits: num(row.debits), lastCallAt: iso(row.last_call_at) } : null;
};

/**
 * The Postgres adapter over a service-role tag (the tables have no policy). `apply` and `bindService` write several rows: hand them a TRANSACTION tag (`sql.begin`). `standingOf`, `list`,
 * `get` and `setSuspended` are single statements.
 */
export function createPostgresConnectionStore(sql: SqlTag): ConnectionStore {
  return {
    async apply({ issuer, claims, services }) {
      const org = await ensureOrg(sql, { kind: "issuer", ref: issuer });
      const status: ConnectionStatus = claims.act === "connect" ? "connected" : "disconnected";
      // One statement checks `seq` and writes: a concurrent connect serializes on the row, and the loser sees a higher stored seq and writes nothing. `suspended` is never in the SET list.
      const rows = await sql`
        INSERT INTO org_connections (org_user_id, billing_account_id, issuer, status, cap, seq)
        VALUES (${org.userId}, ${org.billingAccountId}, ${issuer}, ${status}, ${claims.cap}, ${claims.seq})
        ON CONFLICT (org_user_id) DO UPDATE SET
          status = EXCLUDED.status,
          cap = CASE WHEN EXCLUDED.status = 'connected' THEN EXCLUDED.cap ELSE org_connections.cap END,
          seq = EXCLUDED.seq,
          updated_at = now()
        WHERE org_connections.seq < EXCLUDED.seq
        RETURNING org_user_id, billing_account_id, issuer, status, suspended, cap::text AS cap, seq::text AS seq`;
      const record = toRecord(rows[0]);
      if (!record) {
        const stored = await sql`SELECT seq::text AS seq FROM org_connections WHERE org_user_id = ${org.userId} LIMIT 1`;
        return { ok: false, code: "stale_seq", seq: num(stored[0]?.seq) };
      }
      if (claims.act === "connect") {
        for (const service of new Set(services)) {
          const subjectUserId = await ensureServicePrincipal(sql, { issuer, service });
          await bindSubject(sql, { subjectUserId, billingAccountId: record.billingAccountId, approvedBy: record.orgUserId });
        }
      }
      return { ok: true, record };
    },
    async get(orgUserId) {
      const rows = await sql`
        SELECT org_user_id, billing_account_id, issuer, status, suspended, cap::text AS cap, seq::text AS seq
        FROM org_connections WHERE org_user_id = ${orgUserId} LIMIT 1`;
      return toRecord(rows[0]);
    },
    async standingOf(billingAccountId) {
      const rows = await sql`
        SELECT c.org_user_id, c.billing_account_id, c.issuer, c.status, c.suspended, c.cap::text AS cap, c.seq::text AS seq,
               b.balance_credits::text AS balance, COALESCE(d.debits, 0)::text AS debits, d.last_call_at
        FROM org_connections c
        JOIN billing_accounts b ON b.id = c.billing_account_id
        LEFT JOIN LATERAL (
          SELECT sum(r.charged_credits) AS debits, max(r.created_at) AS last_call_at FROM charge_receipts r WHERE r.billing_account_id = c.billing_account_id
        ) d ON true
        WHERE c.billing_account_id = ${billingAccountId} LIMIT 1`;
      return rows[0] ? toStanding(rows[0]) : null;
    },
    async list({ limit, after }) {
      const bounded = Math.max(1, Math.min(MAX_CONNECTION_ROWS, Math.floor(limit)));
      const rows = await sql`
        SELECT c.org_user_id, c.billing_account_id, c.issuer, c.status, c.suspended, c.cap::text AS cap, c.seq::text AS seq,
               b.balance_credits::text AS balance, COALESCE(d.debits, 0)::text AS debits, d.last_call_at
        FROM org_connections c
        JOIN billing_accounts b ON b.id = c.billing_account_id
        LEFT JOIN LATERAL (
          SELECT sum(r.charged_credits) AS debits, max(r.created_at) AS last_call_at FROM charge_receipts r WHERE r.billing_account_id = c.billing_account_id
        ) d ON true
        WHERE c.issuer > ${after ?? ""}
        ORDER BY c.issuer
        LIMIT ${bounded + 1}`;
      return rows.flatMap((row) => {
        const standing = toStanding(row);
        return standing ? [standing] : [];
      });
    },
    async setSuspended(orgUserId, suspended) {
      const rows = await sql`
        UPDATE org_connections SET suspended = ${suspended}, updated_at = now() WHERE org_user_id = ${orgUserId} RETURNING org_user_id`;
      return rows.length > 0;
    },
    async bindService({ issuer, subjectUserId }) {
      const rows = await sql`SELECT org_user_id, billing_account_id FROM org_connections WHERE issuer = ${issuer} LIMIT 1`;
      const orgUserId = str(rows[0]?.org_user_id);
      const billingAccountId = str(rows[0]?.billing_account_id);
      if (!orgUserId || !billingAccountId) return false;
      await bindSubject(sql, { subjectUserId, billingAccountId, approvedBy: orgUserId });
      return true;
    },
  };
}

/**
 * Binds one subject to the record's account: a live `payer_bindings` row approved by the record's own org user (the signed connect is the consent). A subject's other open row (an old
 * pending ask, a row for another account) is closed first, so the connect is authoritative for the issuer's service principals; the unique open-per-subject index keeps it one row.
 */
async function bindSubject(sql: SqlTag, input: { subjectUserId: string; billingAccountId: string; approvedBy: string }): Promise<void> {
  await sql`
    UPDATE payer_bindings SET revoked_at = now(), revoked_by = ${input.approvedBy}
    WHERE subject_user_id = ${input.subjectUserId} AND revoked_at IS NULL AND billing_account_id <> ${input.billingAccountId}`;
  await sql`
    INSERT INTO payer_bindings (subject_user_id, billing_account_id, approved_by, approved_at)
    VALUES (${input.subjectUserId}, ${input.billingAccountId}, ${input.approvedBy}, now())
    ON CONFLICT (subject_user_id) WHERE revoked_at IS NULL
    DO UPDATE SET approved_by = ${input.approvedBy}, approved_at = now() WHERE payer_bindings.approved_by IS NULL`;
}
