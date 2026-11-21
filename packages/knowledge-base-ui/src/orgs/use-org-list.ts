// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs/use-org-list`
 * Purpose: The data hook behind `/orgs`: the person's orgs with each balance, their open invites, and the two actions (create an org, accept an invite).
 * Scope: Plain `fetch` through `orgRequest`; no react-query. Loads on mount and after every action; the balances load after the rows, one read per org.
 * Invariants:
 *   - STALE_RESPONSE_GUARD: each load takes a sequence number and only the newest is applied.
 *   - BALANCE_IS_NEVER_ZERO_WHEN_UNKNOWN: an org whose balance read failed has `null` (drawn "—"), never 0.
 *   - A later failure keeps an already-ready view; 401, 403 and 404 hide it, a 503 or a first-load failure says "unavailable".
 * Side-effects: IO (fetch)
 * @internal
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAllPages,
  type OrgEndpoints,
  type OrgInvite,
  type OrgListItem,
  orgErrorCopy,
  orgRequest,
  readBalance,
  readPage,
} from "./org-client.js";

export type OrgListState =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly orgs: readonly OrgListItem[];
      readonly invites: readonly OrgInvite[];
      /** Credits by billing account; `undefined` while loading, `null` when the read failed. */
      readonly balances: Readonly<Record<string, number | null | undefined>>;
    };

export interface UseOrgList {
  readonly state: OrgListState;
  /** The action in flight (`create` or an invite id), else null. */
  readonly busy: string | null;
  readonly error: string | null;
  readonly create: (name: string) => Promise<boolean>;
  readonly accept: (inviteId: string) => Promise<void>;
  readonly reload: () => Promise<void>;
}

const GONE = new Set([401, 403, 404]);

export function useOrgList(endpoints: OrgEndpoints): UseOrgList {
  const [state, setState] = useState<OrgListState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);
  const ready = useRef(false);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const fail = (status: number) => {
      if (!alive.current || mine !== seq.current) return;
      if (GONE.has(status)) return setState({ status: "hidden" });
      if (!ready.current) setState({ status: "unavailable" });
    };
    const firstOrgs = await orgRequest(endpoints.orgs);
    if (!firstOrgs.ok) return fail(firstOrgs.status);
    const [orgs, invites] = await Promise.all([
      fetchAllPages<OrgListItem>(endpoints.orgs, "orgs", readPage<OrgListItem>(firstOrgs, "orgs")),
      fetchAllPages<OrgInvite>(`${endpoints.orgs}/invites/mine`, "invites"),
    ]);
    if (!alive.current || mine !== seq.current) return;
    if (!orgs || !invites) return fail(0);
    ready.current = true;
    setState({ status: "ready", orgs: orgs.items, invites: invites.items, balances: {} });
    const now = new Date();
    const entries = await Promise.all(
      orgs.items.map(async (o) => {
        // One ledger row is enough here: the list shows the balance only.
        const reply = await orgRequest(`${endpoints.accounts}/${encodeURIComponent(o.billingAccountId)}/credits?limit=1`);
        return [o.billingAccountId, readBalance(reply, now)?.balance ?? null] as const;
      }),
    );
    if (!alive.current || mine !== seq.current) return;
    setState((s) => (s.status === "ready" ? { ...s, balances: Object.fromEntries(entries) } : s));
  }, [endpoints.orgs, endpoints.accounts]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const run = useCallback(
    async (key: string, request: () => ReturnType<typeof orgRequest>): Promise<boolean> => {
      setBusy(key);
      setError(null);
      const reply = await request();
      if (!reply.ok) setError(orgErrorCopy(reply));
      await reload();
      if (alive.current) setBusy(null);
      return reply.ok;
    },
    [reload],
  );

  return {
    state,
    busy,
    error,
    reload,
    create: (name) => run("create", () => orgRequest(endpoints.orgs, { method: "POST", body: { name: name.trim() } })),
    accept: async (inviteId) => {
      await run(inviteId, () => orgRequest(`${endpoints.orgs}/invites/${encodeURIComponent(inviteId)}/accept`, { method: "POST" }));
    },
  };
}
