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
 *     are all `hidden`. A page cannot tell an admin from anyone else before the server says so.
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
  /** `principal|scope` of the click in flight, else null. While set, every button is disabled. */
  readonly busy: string | null;
  /** A one-line message after a failed click; cleared by the next click. */
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  readonly allow: (principal: string, scope: string) => Promise<void>;
  readonly remove: (principal: string, scope: string) => Promise<void>;
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

export function useAgentAccess(endpoints: AgentAccessEndpoints): UseAgentAccess {
  const [state, setState] = useState<AgentAccessState>({ status: "loading" });
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
      if (res.status === 401 || res.status === 403) {
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
        return commit({ status: "ready", view: body });
      }
      if (typeof body === "object" && body !== null && (body as { canManage?: unknown }).canManage === false) {
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

  const send = useCallback(
    async (method: "POST" | "DELETE", principal: string, scope: string) => {
      setBusy(`${principal}|${scope}`);
      setError(null);
      try {
        const res = await fetch(endpoints.roles, {
          method,
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ principal, scope }),
        });
        if (!res.ok) setError(res.status === 503 ? UNAVAILABLE_COPY : SAVE_FAILED_COPY);
      } catch {
        setError(SAVE_FAILED_COPY);
      }
      // Re-enable the buttons only after the fresh view has landed.
      await reload();
      if (alive.current) setBusy(null);
    },
    [endpoints.roles, reload],
  );

  return {
    state,
    busy,
    error,
    reload,
    allow: (principal, scope) => send("POST", principal, scope),
    remove: (principal, scope) => send("DELETE", principal, scope),
  };
}
