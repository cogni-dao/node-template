// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/approval`
 * Purpose: The pieces of approval that every grant type shares: the one-time link token, the page the link opens, and the ONE gate
 *   `canApprove(me, row)` (ONE_GATE).
 * Scope: Pure, plus store reads for the account-owner check. No routes, no UI.
 * Invariants:
 *   - TOKEN_HASH_ONLY: a link token is 32 CSPRNG bytes, shown once to the asking agent in its link, stored only as sha256. It lives 24 hours,
 *     opens one pending row, and is used up by the decision (or replaced by a re-ask).
 *   - DECLARED_KIND_PICKS_THE_PAGE: a scope that declares kind `account` opens `/profile`; every other kind opens `/admin/ai-access`.
 *   - ONE_GATE: approve, deny and revoke all pass `canApprove`. A node row needs an admin session. An account row needs an approver who owns
 *     the row's account (or, for an ask not yet decided, owns an account at all). Both need an approver who is not the asking principal.
 *     A node-admin has no veto over an account row.
 * Side-effects: none (store reads in `canApprove` for an account row)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard (ONE_GATE, TWO_STARTS)
 * @public
 */

import type { AgentGrantsStore, GrantResource, ScopeKind } from "./types";

/** A one-time link lives 24 hours. */
export const LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** The URL fragment key that carries the link token. A fragment is never sent to a server and is stripped from history on landing. */
export const APPROVAL_FRAGMENT_KEY = "agent-request";

/** Days an account owner may pick for an account grant, and the default. 30 is the most the migration CHECK allows. */
export const ACCOUNT_GRANT_DAYS = [1, 7, 30] as const;
export const DEFAULT_ACCOUNT_GRANT_DAYS = 7;
export type AccountGrantDays = (typeof ACCOUNT_GRANT_DAYS)[number];

export const isAccountGrantDays = (n: unknown): n is AccountGrantDays =>
  typeof n === "number" && (ACCOUNT_GRANT_DAYS as readonly number[]).includes(n);

/** The resource a scope's declared kind puts its row on: `account` for an account scope, `node` for every other kind. */
export const resourceOfKind = (kind: ScopeKind): GrantResource => (kind === "account" ? "account" : "node");

/** The page the approval link opens, from the row's resource. */
export const APPROVAL_PAGE: Readonly<Record<GrantResource, string>> = {
  node: "/admin/ai-access",
  account: "/profile",
};

/** The path and fragment an asking agent hands its person, by the scope's declared kind. The node adds its public origin. */
export function approvalPath(kind: ScopeKind, token: string): string {
  return `${APPROVAL_PAGE[resourceOfKind(kind)]}#${APPROVAL_FRAGMENT_KEY}=${token}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new link token: 43 base64url characters from 32 CSPRNG bytes. */
export function newLinkToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** True for a string shaped like a link token (never a way to check it is valid; the store does that). */
export const isLinkTokenShape = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);

/** sha256 hex of a link token: what the store keeps and looks up. */
export async function hashLinkToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Who is deciding. `admin` is the node's `AdminSession` (made only by `requireAdminSession()`), or null for anyone else. The package never
 * looks inside it: its presence is the whole proof of node-admin.
 */
export interface ApprovalCaller {
  readonly userId: string;
  readonly admin: object | null;
}

/** The row a decision is about. `accountId` is null for a node row and for an account ask that has no account yet. */
export interface ApprovalRow {
  readonly resource: GrantResource;
  readonly principalUserId: string;
  readonly accountId?: string | null | undefined;
}

/**
 * ONE_GATE: may `me` approve, deny or revoke this row? Every decision in the package, and so on both routes, calls this and nothing else.
 *   - never the asking principal (NO_SELF_APPROVAL), for any row;
 *   - a node row: an admin session is present;
 *   - an account row with an account: `me` owns that account;
 *   - an account ask with no account yet: `me` owns an account (the decision writes that account onto the row).
 * A store failure is a throw; the caller maps it to "unavailable", never to yes.
 */
export async function canApprove(store: AgentGrantsStore, me: ApprovalCaller, row: ApprovalRow): Promise<boolean> {
  if (me.userId === row.principalUserId) return false;
  if (row.resource === "node") return me.admin !== null;
  if (row.accountId) return store.ownsAccount(me.userId, row.accountId);
  return (await store.accountOf(me.userId)) !== null;
}
