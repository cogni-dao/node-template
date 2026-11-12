// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/use-agent-access`
 * Purpose: The data hook behind "This node's AI": loads the admin view, and allows or removes one permission.
 * Scope: Plain `fetch` with `cache: "no-store"`; no react-query and no kept copy beyond component state.
 *   Loads on mount, on window focus (not while hidden) and after every click.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: requests carry the browser session only; this hook never sets an Authorization header.
 *   - NON_ADMIN_SEES_NOTHING: only a confirmed admin view (`canManage: true` with a well-formed list of permissions) is `ready`, and only
 *     a confirmed 503 is `unavailable`. Loading, 401, 403, 404, 500, any other status, a network error and a malformed body
 *     are all `hidden`. 401, 403 and 404 are confirmed (focus does not retry them); 500, 429, a network error and a bad body
 *     are transient (focus retries). A page cannot tell an admin from anyone else before the server says so.
 *   - A later non-503 failure keeps an already-ready view (a click must not make an admin's block vanish); 401 and 403 hide it.
 *   - Window focus re-checks unless the server confirmed "not an admin"; a transient first-load failure therefore recovers.
 *   - STALE_RESPONSE_GUARD: each load takes a sequence number; only the newest response is applied, so a focus load that
 *     started before a click cannot overwrite the post-click view.
 * Side-effects: IO (fetch)
 * @internal
 */

"use client";

import type { NodeAiAccessView } from "@cogni/agent-grants";
import { useCallback, useEffect, useRef, useState } from "react";

export interface AgentAccessEndpoints {
  /** The human-plane roles route, GET + POST + DELETE. */
  readonly roles: string;
}

export type AgentAccessState =
  /** Nothing is shown while the first answer is pending. */
  | { readonly status: "loading" }
  /** Not an admin, or any failure other than a confirmed 503. Nothing is shown. */
  | { readonly status: "hidden" }
  /** A confirmed 503: the page cannot check access. Shown to whoever loads it (accepted per design). */
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly view: NodeAiAccessView };

export interface UseAgentAccess {
  readonly state: AgentAccessState;
  /** `principalUserId|scope` of the click in flight, else null. While set, every button is disabled. */
  readonly busy: string | null;
  /** A one-line message after a failed click; cleared by the next click. */
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
  readonly loadingMore: boolean;
  /** Turn a row ON: approves a pending ask or grants one of this node's AI. */
  readonly allow: (principalUserId: string, scope: string) => Promise<void>;
  /** Turn a row OFF. */
  readonly remove: (principalUserId: string, scope: string) => Promise<void>;
  /** The x on a pending ask. */
  readonly dismiss: (principalUserId: string, scope: string) => Promise<void>;
}

export const UNAVAILABLE_COPY = "Can't check access right now. Try again.";
const SAVE_FAILED_COPY = "Couldn't save that change. Try again.";

function isAdminView(value: unknown): value is NodeAiAccessView {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { canManage?: unknown }).canManage === true &&
    Array.isArray((value as { permissions?: unknown }).permissions)
  );
}

export function useAgentAccess(
  endpoints: AgentAccessEndpoints
): UseAgentAccess {
  const [state, setState] = useState<AgentAccessState>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);
  /** The latest state, readable outside React's updater. */
  const current = useRef<AgentAccessState>({ status: "loading" });
  /** True only after the server said "not an admin" (canManage false, 401 or 403). A transient failure never sets it. */
  const confirmedNotAdmin = useRef(false);

  const commit = useCallback((next: AgentAccessState) => {
    current.current = next;
    setState(next);
  }, []);

  /** A transient failure (404, 429, 500, network, bad body): keep an admin's ready view, else show nothing and retry later. */
  const transientFailure = useCallback(() => {
    if (current.current.status !== "ready") commit({ status: "hidden" });
  }, [commit]);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch(endpoints.roles, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!alive.current || mine !== seq.current) return;
      // 404 means this node has no such route: permanent, so it is confirmed like a 401 or 403 and focus does not retry it.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        confirmedNotAdmin.current = true;
        return commit({ status: "hidden" });
      }
      if (res.status === 503) {
        confirmedNotAdmin.current = false;
        return commit({ status: "unavailable" });
      }
      if (!res.ok) return transientFailure();
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!alive.current || mine !== seq.current) return;
      if (isAdminView(body)) {
        confirmedNotAdmin.current = false;
        return commit({
          status: "ready",
          view: {
            ...body,
            more:
              typeof (body as { more?: unknown }).more === "number"
                ? body.more
                : 0,
          },
        });
      }
      if (
        typeof body === "object" &&
        body !== null &&
        (body as { canManage?: unknown }).canManage === false
      ) {
        confirmedNotAdmin.current = true;
        return commit({ status: "hidden" });
      }
      transientFailure();
    } catch {
      if (alive.current && mine === seq.current) transientFailure();
    }
  }, [endpoints.roles, commit, transientFailure]);

  useEffect(() => {
    alive.current = true;
    void reload();
    // Focus re-checks, except after the server confirmed this caller is not an admin (no wasted admin check). An admin whose
    // first load failed transiently is not "confirmed", so focus retries and the block can appear.
    const onFocus = () => {
      if (!confirmedNotAdmin.current) void reload();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [reload]);

  const loadMore = useCallback(async () => {
    const before = current.current;
    if (before.status !== "ready" || !before.view.nextCursor || loadingMore)
      return;
    const cursor = before.view.nextCursor,
      mine = ++seq.current;
    setLoadingMore(true);
    setError(null);
    const params = new URLSearchParams({
      afterPrincipal: cursor.principalUserId,
      afterScope: cursor.scope,
    });
    try {
      const res = await fetch(`${endpoints.roles}?${params}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const body: unknown = await res.json();
      if (!alive.current || mine !== seq.current) return;
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        confirmedNotAdmin.current = true;
        commit({ status: "hidden" });
        return;
      }
      if (!res.ok || !isAdminView(body)) {
        setError(UNAVAILABLE_COPY);
        return;
      }
      // Internal rows recur in each bounded projection; one control per principal/scope survives page boundaries.
      const controls = new Map(
        before.view.permissions.map((p) => [
          `${p.principalUserId}|${p.scope}`,
          p,
        ])
      );
      for (const permission of body.permissions)
        controls.set(
          `${permission.principalUserId}|${permission.scope}`,
          permission
        );
      commit({
        status: "ready",
        view: { ...body, permissions: [...controls.values()] },
      });
    } catch {
      if (alive.current && mine === seq.current) setError(UNAVAILABLE_COPY);
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  }, [endpoints.roles, loadingMore, commit]);

  const send = useCallback(
    async (
      method: "POST" | "DELETE",
      principalUserId: string,
      scope: string,
      deny = false
    ) => {
      setBusy(`${principalUserId}|${scope}`);
      setError(null);
      try {
        const res = await fetch(endpoints.roles, {
          method,
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            principalUserId,
            scope,
            ...(deny ? { deny: true } : {}),
          }),
        });
        if (!res.ok)
          setError(res.status === 503 ? UNAVAILABLE_COPY : SAVE_FAILED_COPY);
      } catch {
        setError(SAVE_FAILED_COPY);
      }
      // Re-enable the buttons only after the fresh view has landed.
      await reload();
      if (alive.current) setBusy(null);
    },
    [endpoints.roles, reload]
  );

  return {
    state,
    busy,
    error,
    reload,
    loadMore,
    loadingMore,
    allow: (principalUserId, scope) => send("POST", principalUserId, scope),
    remove: (principalUserId, scope) => send("DELETE", principalUserId, scope),
    dismiss: (principalUserId, scope) =>
      send("DELETE", principalUserId, scope, true),
  };
}
