// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs/use-org-admin`
 * Purpose: The data hook behind the node admin's org rows on `/admin`: the orgs on the node a page at a time, and Suspend.
 * Scope: Plain `fetch` through `orgRequest`; no react-query. Loads page one on mount; `more` appends the next page. A confirmed suspend marks that row in place (no reload, so loaded pages stay).
 * Invariants:
 *   - NON_ADMIN_SEES_NOTHING: only a well-formed list is `ready`; loading, 401, 403, 404 and any failure are `hidden`, and only a confirmed 503 is `unavailable`.
 *   - SUSPEND_IS_FINAL: the only write is `{ suspended: true }`; this hook never sends `false`.
 *   - PAGED_LIST: `nextCursor` is the server's own cursor, null on the last page; the list is never walked to its end on its own.
 *   - STALE_RESPONSE_GUARD: each load takes a sequence number and only the newest is applied.
 * Side-effects: IO (fetch)
 * @internal
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type AdminOrgItem, type OrgEndpoints, orgErrorCopy, orgRequest, readPage, withCursor } from "./org-client.js";

export type OrgAdminState =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly orgs: readonly AdminOrgItem[]; readonly nextCursor: string | null };

export interface UseOrgAdmin {
  readonly state: OrgAdminState;
  /** The org being suspended (its id), `more` while the next page loads, else null. */
  readonly busy: string | null;
  readonly error: string | null;
  readonly suspend: (orgUserId: string) => Promise<void>;
  /** Appends the next page; does nothing when there is none. */
  readonly more: () => Promise<void>;
  readonly reload: () => Promise<void>;
}

export function useOrgAdmin(endpoints: OrgEndpoints): UseOrgAdmin {
  const list = endpoints.adminOrgs ?? "";
  const [state, setState] = useState<OrgAdminState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    if (!list) return setState({ status: "hidden" });
    const first = await orgRequest(list);
    if (!alive.current || mine !== seq.current) return;
    if (!first.ok) {
      if (first.status === 503) return setState({ status: "unavailable" });
      // A transient failure keeps a ready list; a refusal hides it.
      const refused = first.status === 401 || first.status === 403 || first.status === 404;
      return setState((s) => (s.status === "ready" && !refused ? s : { status: "hidden" }));
    }
    const page = readPage<AdminOrgItem>(first, "orgs");
    setState((s) => (page ? { status: "ready", orgs: page.items, nextCursor: page.nextCursor } : s.status === "ready" ? s : { status: "hidden" }));
  }, [list]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const suspend = useCallback(
    async (orgUserId: string) => {
      setBusy(orgUserId);
      setError(null);
      const reply = await orgRequest(`${endpoints.orgs}/${encodeURIComponent(orgUserId)}/suspension`, { method: "POST", body: { suspended: true } });
      if (!alive.current) return;
      if (reply.ok) setState((s) => (s.status === "ready" ? { ...s, orgs: s.orgs.map((o) => (o.orgUserId === orgUserId ? { ...o, suspended: true } : o)) } : s));
      else setError(orgErrorCopy(reply));
      setBusy(null);
    },
    [endpoints.orgs],
  );

  const more = useCallback(async () => {
    if (state.status !== "ready" || state.nextCursor === null) return;
    setBusy("more");
    setError(null);
    const reply = await orgRequest(withCursor(list, state.nextCursor));
    if (!alive.current) return;
    const page = readPage<AdminOrgItem>(reply, "orgs");
    if (page) setState((s) => (s.status === "ready" ? { status: "ready", orgs: [...s.orgs, ...page.items], nextCursor: page.nextCursor } : s));
    else setError(orgErrorCopy(reply));
    setBusy(null);
  }, [list, state]);

  return { state, busy, error, suspend, more, reload };
}
