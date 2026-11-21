// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs/use-org`
 * Purpose: The data hook behind `/orgs/[id]`: the org, the caller's role, its balance, every person and every linked node, and the actions on them
 *   (change a role, remove, invite, unlink, make a link code).
 * Scope: Plain `fetch` through `orgRequest`; no react-query. Loads on mount and after every action. The people and links follow their cursors to the end.
 * Invariants:
 *   - STALE_RESPONSE_GUARD: each load takes a sequence number and only the newest is applied.
 *   - NON_DISCLOSING: a 404 (an unknown org, or one the caller is not in, or a removed person) is one `missing` state; 401 and 403 are `hidden`.
 *   - THE_SERVER_DECIDES: the hook sends what the person clicked and shows the server's refusal in plain words; the menus only hide actions the caller's role can never do.
 *   - CODE_STAYS_IN_MEMORY: a link code is held in this hook only, shown once, and dropped by `clearCode`.
 * Side-effects: IO (fetch)
 * @internal
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAllPages,
  LEDGER_PAGE,
  type OrgBalance,
  type OrgEndpoints,
  type OrgLink,
  type OrgMember,
  type OrgRecord,
  type OrgRole,
  orgErrorCopy,
  orgRequest,
  readBalance,
} from "./org-client.js";

export interface OrgLinkCode {
  readonly code: string;
  readonly origin: string;
  readonly expiresAt: string;
}

export type OrgState =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "missing" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly org: OrgRecord;
      readonly role: OrgRole;
      readonly members: readonly OrgMember[];
      readonly links: readonly OrgLink[];
      /** `undefined` while loading, `null` when the read failed. */
      readonly balance: OrgBalance | null | undefined;
    };

export interface UseOrg {
  readonly state: OrgState;
  /** The action in flight (`role:<id>`, `remove:<id>`, `invite`, `unlink:<id>`, `code`), else null. */
  readonly busy: string | null;
  readonly error: string | null;
  readonly linkCode: OrgLinkCode | null;
  readonly setRole: (userId: string, role: OrgRole) => Promise<void>;
  readonly remove: (userId: string) => Promise<void>;
  readonly invite: (wallet: string, role: OrgRole) => Promise<boolean>;
  readonly unlink: (linkId: string) => Promise<void>;
  readonly makeCode: (origin: string) => Promise<boolean>;
  readonly clearCode: () => void;
  readonly reload: () => Promise<void>;
}

const isRole = (v: unknown): v is OrgRole => v === "owner" || v === "admin";

export function useOrg(endpoints: OrgEndpoints, orgId: string): UseOrg {
  const base = `${endpoints.orgs}/${encodeURIComponent(orgId)}`;
  const [state, setState] = useState<OrgState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<OrgLinkCode | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);
  const ready = useRef(false);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const current = () => alive.current && mine === seq.current;
    const view = await orgRequest(base);
    if (!current()) return;
    if (!view.ok) {
      if (view.status === 401 || view.status === 403) return setState({ status: "hidden" });
      if (view.status === 404) return setState({ status: "missing" });
      if (!ready.current) setState({ status: "unavailable" });
      return;
    }
    const body = view.body as {
      org?: OrgRecord;
      role?: unknown;
      members?: { items?: OrgMember[]; nextCursor?: string | null };
      links?: { items?: OrgLink[]; nextCursor?: string | null };
    } | null;
    if (!body?.org || !isRole(body.role) || !body.members?.items || !body.links?.items) {
      if (!ready.current) setState({ status: "unavailable" });
      return;
    }
    const first = <T,>(page: { items?: T[]; nextCursor?: string | null }) => ({ items: page.items ?? [], nextCursor: page.nextCursor ?? null });
    const [members, links] = await Promise.all([
      fetchAllPages<OrgMember>(`${base}/members`, "items", first(body.members)),
      fetchAllPages<OrgLink>(`${base}/links`, "items", first(body.links)),
    ]);
    if (!current()) return;
    if (!members || !links) {
      if (!ready.current) setState({ status: "unavailable" });
      return;
    }
    ready.current = true;
    const { org, role } = body as { org: OrgRecord; role: OrgRole };
    setState((s) => ({
      status: "ready",
      org,
      role,
      members: members.items,
      links: links.items,
      balance: s.status === "ready" ? s.balance : undefined,
    }));
    const credits = await orgRequest(`${endpoints.accounts}/${encodeURIComponent(org.billingAccountId)}/credits?limit=${LEDGER_PAGE}`);
    if (!current()) return;
    const balance = readBalance(credits, new Date());
    setState((s) => (s.status === "ready" ? { ...s, balance } : s));
  }, [base, endpoints.accounts]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const run = useCallback(
    async (key: string, request: () => ReturnType<typeof orgRequest>) => {
      setBusy(key);
      setError(null);
      const reply = await request();
      if (!reply.ok) setError(orgErrorCopy(reply));
      await reload();
      if (alive.current) setBusy(null);
      return reply;
    },
    [reload],
  );

  const member = (userId: string) => `${base}/members/${encodeURIComponent(userId)}`;

  return {
    state,
    busy,
    error,
    linkCode,
    reload,
    setRole: async (userId, role) => {
      await run(`role:${userId}`, () => orgRequest(member(userId), { method: "PATCH", body: { role } }));
    },
    remove: async (userId) => {
      await run(`remove:${userId}`, () => orgRequest(member(userId), { method: "DELETE" }));
    },
    invite: async (wallet, role) => (await run("invite", () => orgRequest(`${base}/invites`, { method: "POST", body: { wallet: wallet.trim(), role } }))).ok,
    unlink: async (linkId) => {
      await run(`unlink:${linkId}`, () => orgRequest(`${base}/links/${encodeURIComponent(linkId)}`, { method: "DELETE" }));
    },
    makeCode: async (origin) => {
      const reply = await run("code", () => orgRequest(`${base}/link-codes`, { method: "POST", body: { origin: origin.trim() } }));
      const b = reply.body as Partial<OrgLinkCode> | null;
      if (!reply.ok || typeof b?.code !== "string") return false;
      setLinkCode({ code: b.code, origin: b.origin ?? "", expiresAt: b.expiresAt ?? "" });
      return true;
    },
    clearCode: () => setLinkCode(null),
  };
}
