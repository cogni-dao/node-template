// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs/org-client`
 * Purpose: The wire shapes, the one fetch helper and the plain-words error copy the three org sections share (task.0181).
 * Scope: Plain `fetch` with `cache: "no-store"` and the browser session; no react-query, no node code. Every request goes to a path the node passes in `OrgEndpoints`.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: requests carry the browser session only; nothing here sets an Authorization header.
 *   - ONE_ERROR_VOICE: a refusal code from the server (`{ error }`) becomes one short sentence from `ORG_ERROR_COPY`; an unknown code or status never shows raw text.
 *   - PAGES_ARE_WHOLE: `fetchAllPages` follows `nextCursor` until it is null (a repeated cursor stops it), so a list is never silently cut.
 *   - SPEND_IS_FROM_THE_LEDGER: "spent this month" is the sum of this UTC month's charge rows in the newest-first ledger page; when that page ends inside the month the figure is a floor and `partial` is true.
 * Side-effects: IO (fetch)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @internal
 */

export type OrgRole = "owner" | "admin";

export interface OrgEndpoints {
  /** The org routes: list and create, `/{id}`, `/{id}/members`, `/{id}/invites`, `/{id}/link-codes`, `/{id}/links`, `/{id}/suspension`, `/invites/mine`, `/invites/{id}/accept` (`/api/v1/orgs`). */
  readonly orgs: string;
  /** The account door; the balance is `GET {accounts}/{billingAccountId}/credits` (`/api/v1/accounts`). */
  readonly accounts: string;
  /** The node admin's list of every org, a page at a time (`/api/v1/admin/orgs`). Needed only by `OrgAdminSection`. */
  readonly adminOrgs?: string;
}

export interface OrgListItem {
  readonly orgUserId: string;
  readonly name: string;
  readonly billingAccountId: string;
  readonly suspended: boolean;
  readonly role: OrgRole;
}

export interface OrgRecord {
  readonly orgUserId: string;
  readonly name: string;
  readonly billingAccountId: string;
  readonly suspended: boolean;
}

export interface OrgInvite {
  readonly id: string;
  readonly orgUserId: string;
  readonly orgName: string;
  readonly role: OrgRole;
  readonly expiresAt: string;
}

export interface OrgMember {
  readonly userId: string;
  readonly name: string | null;
  readonly role: OrgRole;
  readonly since: string;
}

export interface OrgLink {
  readonly id: string;
  readonly issuer: string;
  readonly services: readonly string[];
  readonly createdAt: string;
}

export interface AdminOrgItem {
  readonly orgUserId: string;
  readonly name: string;
  readonly suspended: boolean;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface OrgReply {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

const NETWORK_FAILURE: OrgReply = { ok: false, status: 0, body: null };

/** One request to the org routes: JSON in, JSON out, the session cookie only. A network failure is status 0. */
export async function orgRequest(url: string, init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {}): Promise<OrgReply> {
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return NETWORK_FAILURE;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const asArray = <T>(v: unknown): T[] | null => (Array.isArray(v) ? (v as T[]) : null);

/** `cursor=` appended to a list URL. */
export const withCursor = (url: string, cursor: string): string => `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;

/** Reads `{ [key]: T[], nextCursor }` out of a reply; null when the reply failed or is not a page. */
export function readPage<T>(reply: OrgReply, key: string): Page<T> | null {
  if (!reply.ok || !isRecord(reply.body)) return null;
  const items = asArray<T>(reply.body[key]);
  if (!items) return null;
  const next = reply.body.nextCursor;
  return { items, nextCursor: typeof next === "string" ? next : null };
}

/** Every page of one list, in order, starting from `first` when the caller already has page one. Stops at a null cursor or a repeated one. Null when a page fails. */
export async function fetchAllPages<T>(url: string, key: string, first?: Page<T> | null): Promise<Page<T> | null> {
  const items: T[] = [];
  let page: Page<T> | null = first ?? readPage<T>(await orgRequest(url), key);
  const seen = new Set<string>();
  while (page) {
    items.push(...page.items);
    const cursor = page.nextCursor;
    if (cursor === null || seen.has(cursor)) return { items, nextCursor: null };
    seen.add(cursor);
    page = readPage<T>(await orgRequest(withCursor(url, cursor)), key);
  }
  return null;
}

export const ORG_ERROR_COPY: Readonly<Record<string, string>> = {
  org_role_limit: "You already have a role in an org. Only one is allowed for now.",
  too_many_orgs: "You already own the most orgs allowed.",
  last_owner: "An org keeps at least one owner.",
  not_allowed: "Only an owner can do that.",
  authz_denied: "Only an owner can do that.",
  already_member: "That person is already in this org.",
  invalid_name: "Enter a name for the org.",
  invalid_wallet: "Enter a wallet address.",
  invalid_role: "Choose owner or admin.",
  invite_not_found: "That invite is gone.",
  invite_void: "That invite has expired or was used.",
  too_many_invites: "Too many open invites. Wait for some to be used.",
  invalid_origin: "Enter an https address, like https://node.example.",
  issuer_already_linked: "That node is already linked.",
  too_many_codes: "Too many open codes. Wait 15 minutes.",
  org_suspended: "This org is suspended.",
  conflict: "That changed while you were saving. Try again.",
  not_found: "That is not available.",
};

export const UNAVAILABLE_COPY = "Can't check access right now. Try again.";
export const SAVE_FAILED_COPY = "Couldn't save that. Try again.";

/** One plain sentence for a failed action: the code's copy, the outage copy for 503 or a network failure, else the generic one. */
export function orgErrorCopy(reply: OrgReply): string {
  const code = isRecord(reply.body) && typeof reply.body.error === "string" ? reply.body.error : null;
  if (code && Object.prototype.hasOwnProperty.call(ORG_ERROR_COPY, code)) return ORG_ERROR_COPY[code] as string;
  return reply.status === 503 || reply.status === 0 ? UNAVAILABLE_COPY : SAVE_FAILED_COPY;
}

/** A credit count for a person: grouped digits, no unit words. */
export const formatCredits = (n: number): string => Math.round(n).toLocaleString("en-US");

interface LedgerRow {
  readonly amount: number;
  readonly reason: string;
  readonly createdAt: string;
}

export interface OrgBalance {
  readonly balance: number;
  /** Credits charged since the first of this UTC month. */
  readonly spent: number;
  /** True when the ledger page ended inside the month, so `spent` is a floor. */
  readonly partial: boolean;
}

/** The ledger rows one balance read asks for. */
export const LEDGER_PAGE = 100;

/** Reads `{ balanceCredits, ledger }`; null when the reply is not a credits summary. */
export function readBalance(reply: OrgReply, now: Date): OrgBalance | null {
  if (!reply.ok || !isRecord(reply.body) || typeof reply.body.balanceCredits !== "number") return null;
  const ledger = asArray<LedgerRow>(reply.body.ledger) ?? [];
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let spent = 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of ledger) {
    const at = Date.parse(row.createdAt);
    if (Number.isNaN(at)) continue;
    oldest = Math.min(oldest, at);
    if (at >= monthStart && row.reason === "charge_receipt" && row.amount < 0) spent += -row.amount;
  }
  return { balance: reply.body.balanceCredits, spent, partial: ledger.length >= LEDGER_PAGE && oldest >= monthStart };
}

/** A person's name, else a short form of their id (the member list carries no wallet). */
export function memberLabel(m: { name: string | null; userId: string }): string {
  if (m.name?.trim()) return m.name;
  return m.userId.length > 12 ? `${m.userId.slice(0, 6)}…${m.userId.slice(-4)}` : m.userId;
}
