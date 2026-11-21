// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs/use-org-admin`
 * Purpose: The data hook behind the node admin's org rows on `/admin`: every org on the node, and Suspend.
 * Scope: Plain `fetch` through `orgRequest`; no react-query. Loads on mount and after a suspend. The list follows its cursors to the end.
 * Invariants:
 *   - NON_ADMIN_SEES_NOTHING: only a well-formed list is `ready`; loading, 401, 403, 404 and any failure are `hidden`, and only a confirmed 503 is `unavailable`.
 *   - SUSPEND_IS_FINAL: the only write is `{ suspended: true }`; this hook never sends `false`.
 *   - STALE_RESPONSE_GUARD: each load takes a sequence number and only the newest is applied.
 * Side-effects: IO (fetch)
 * @internal
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type AdminOrgItem, fetchAllPages, type OrgEndpoints, orgErrorCopy, orgRequest, readPage } from "./org-client.js";

export type OrgAdminState =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly orgs: readonly AdminOrgItem[] };

export interface UseOrgAdmin {
  readonly state: OrgAdminState;
  /** The org being suspended, else null. */
  readonly busy: string | null;
  readonly error: string | null;
  readonly suspend: (orgUserId: string) => Promise<void>;
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
    const all = await fetchAllPages<AdminOrgItem>(list, "orgs", readPage<AdminOrgItem>(first, "orgs"));
    if (!alive.current || mine !== seq.current) return;
    setState((s) => (all ? { status: "ready", orgs: all.items } : s.status === "ready" ? s : { status: "hidden" }));
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
      if (!reply.ok) setError(orgErrorCopy(reply));
      await reload();
      if (alive.current) setBusy(null);
    },
    [endpoints.orgs, reload],
  );

  return { state, busy, error, suspend, reload };
}
