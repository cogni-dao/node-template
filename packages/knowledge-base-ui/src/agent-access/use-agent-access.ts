// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/use-agent-access`
 * Purpose: The data hook behind "AI access": loads one table, and allows or removes one permission. Two modes share it.
 *   - `admin` (default): a node-admin's table of NODE permissions on `/admin/ai-access`.
 *   - `account`: a person's table of the AIs that may act on THEIR OWN account on `/profile`, with the Until control (1, 7 or 30 days).
 *   Both can open an AI's one-time link: the page passes the token it read from the URL fragment, the hook asks the preview endpoint which row it opens,
 *   and the section highlights that row.
 * Scope: Plain `fetch` with `cache: "no-store"`; no react-query and no kept copy beyond component state.
 *   Loads on mount, on window focus (not while hidden) and after every click.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: requests carry the browser session only; this hook never sets an Authorization header.
 *   - NON_ADMIN_SEES_NOTHING (admin mode): only a confirmed admin view (`canManage: true` with a well-formed list of permissions) is `ready`, and only
 *     a confirmed 503 is `unavailable`. Loading, 401, 403, 404, 500, any other status, a network error and a malformed body
 *     are all `hidden`. 401, 403 and 404 are confirmed (focus does not retry them); 500, 429, a network error and a bad body
 *     are transient (focus retries). A page cannot tell an admin from anyone else before the server says so.
 *   - EVERY_SIGNED_IN_PERSON (account mode): a well-formed list is `ready` for whoever the server answers; there is no `canManage` to hide behind. Loading is
 *     `loading` (the section shows a Skeleton); 401, 403 and 404 are `hidden`.
 *   - A later non-503 failure keeps an already-ready view (a click must not make a block vanish); 401 and 403 hide it.
 *   - Window focus re-checks unless the server confirmed "not an admin" (admin mode); a transient first-load failure therefore recovers.
 *   - STALE_RESPONSE_GUARD: each load takes a sequence number; only the newest response is applied, so a focus load that
 *     started before a click cannot overwrite the post-click view.
 *   - TOKEN_STAYS_IN_MEMORY: the link token is held in this hook only to preview and to decide; it is sent in a POST or DELETE body, never in a URL, and
 *     it is dropped when the ask is decided. An unusable token (a 404) shows one neutral line and nothing else.
 * Side-effects: IO (fetch)
 * @internal
 */

"use client";

import type { NodeAiAccessView, NodeAiPermissionView } from "@cogni/agent-grants";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface AgentAccessEndpoints {
  /** The human-plane list route, GET + POST + DELETE (admin: `/api/v1/admin/ai-access`; account: `/api/v1/agent-access/mine`). */
  readonly roles: string;
  /** POST `{ token }` returns `{ permission }`: the waiting ask a link opens. Needed only to highlight an ask opened by its link. */
  readonly preview?: string;
}

export type AgentAccessMode = "admin" | "account";

export interface UseAgentAccessOptions {
  readonly mode?: AgentAccessMode;
  /** The one-time link token the page read from the URL fragment (`useApprovalFragment`), or null. */
  readonly token?: string | null;
}

export type AgentAccessState =
  /** Nothing is shown while the first answer is pending (admin), or a Skeleton (account). */
  | { readonly status: "loading" }
  /** Not an admin, or any failure other than a confirmed 503. Nothing is shown. */
  | { readonly status: "hidden" }
  /** A confirmed 503: the page cannot check access. Shown to whoever loads it (accepted per design). */
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly view: NodeAiAccessView };

/** Options of one click. `days` is the Until control (1, 7 or 30), used on an account row; the server defaults to 7. */
export interface AllowOptions {
  readonly days?: number;
}

export interface UseAgentAccess {
  readonly state: AgentAccessState;
  /** `principalUserId|scope` of the click in flight, else null. While set, every button is disabled. */
  readonly busy: string | null;
  /** A one-line message after a failed click; cleared by the next click. */
  readonly error: string | null;
  /** `principalUserId|scope` of the row the link opened, else null. The section highlights it. */
  readonly highlight: string | null;
  /** True after the server said the link is not usable (used, expired, wrong page or unknown). */
  readonly linkInvalid: boolean;
  readonly reload: () => Promise<void>;
  /** Turn a row ON: approves a pending ask or grants one of this node's AI. */
  readonly allow: (principalUserId: string, scope: string, options?: AllowOptions) => Promise<void>;
  /** Turn a row OFF. */
  readonly remove: (principalUserId: string, scope: string) => Promise<void>;
  /** The x on a pending ask. */
  readonly dismiss: (principalUserId: string, scope: string) => Promise<void>;
}

export const UNAVAILABLE_COPY = "Can't check access right now. Try again.";
export const LINK_INVALID_COPY = "That link is not valid any more. Ask the AI for a new one.";
const SAVE_FAILED_COPY = "Couldn't save that change. Try again.";

export const rowKey = (row: { principalUserId: string; scope: string }) => `${row.principalUserId}|${row.scope}`;

function isAdminView(value: unknown): value is NodeAiAccessView {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { canManage?: unknown }).canManage === true &&
    Array.isArray((value as { permissions?: unknown }).permissions)
  );
}

const isList = (value: unknown): value is { permissions: NodeAiPermissionView[] } =>
  typeof value === "object" && value !== null && Array.isArray((value as { permissions?: unknown }).permissions);

export function useAgentAccess(endpoints: AgentAccessEndpoints, options: UseAgentAccessOptions = {}): UseAgentAccess {
  const mode: AgentAccessMode = options.mode ?? "admin";
  const token = options.token ?? null;
  const [loaded, setLoaded] = useState<AgentAccessState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<NodeAiPermissionView | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [linkInvalid, setLinkInvalid] = useState(false);
  const alive = useRef(true);
  const seq = useRef(0);
  /** The latest loaded state, readable outside React's updater. */
  const current = useRef<AgentAccessState>({ status: "loading" });
  /** The token of the ask still waiting for its decision; dropped once it is decided. */
  const tokenRef = useRef<string | null>(token);
  /** True only after the server said "not an admin" (canManage false, 401 or 403). A transient failure never sets it. */
  const confirmedNotAdmin = useRef(false);

  const commit = useCallback((next: AgentAccessState) => {
    current.current = next;
    setLoaded(next);
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
      const more = typeof (body as { more?: unknown } | null)?.more === "number" ? (body as { more: number }).more : 0;
      if (mode === "account") {
        if (isList(body)) {
          confirmedNotAdmin.current = false;
          return commit({ status: "ready", view: { canManage: true, permissions: body.permissions, more } });
        }
        return transientFailure();
      }
      if (isAdminView(body)) {
        confirmedNotAdmin.current = false;
        return commit({ status: "ready", view: { ...body, more } });
      }
      if (typeof body === "object" && body !== null && (body as { canManage?: unknown }).canManage === false) {
        confirmedNotAdmin.current = true;
        return commit({ status: "hidden" });
      }
      transientFailure();
    } catch {
      if (alive.current && mine === seq.current) transientFailure();
    }
  }, [endpoints.roles, mode, commit, transientFailure]);

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

  // A link opened this page: ask the server which waiting ask the token names. One 404 covers every unusable token.
  const { preview } = endpoints;
  useEffect(() => {
    tokenRef.current = token;
    if (!token || !preview) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(preview, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled || !alive.current) return;
        if (res.status === 404) return setLinkInvalid(true);
        if (!res.ok) return;
        const body = (await res.json()) as { permission?: NodeAiPermissionView };
        if (cancelled || !alive.current || !body.permission) return;
        setLinkInvalid(false);
        setHighlight(rowKey(body.permission));
        // An account ask has no row on the person's list yet (its account is set by the decision), so the page shows it from the preview.
        if (mode === "account") setAsk(body.permission);
      } catch {
        // A failed preview only costs the highlight.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, preview, mode]);

  const state = useMemo<AgentAccessState>(() => {
    if (loaded.status !== "ready" || !ask || mode !== "account") return loaded;
    const key = rowKey(ask);
    const rest = loaded.view.permissions.filter((p) => !(p.section === "pending" && rowKey(p) === key));
    return { status: "ready", view: { ...loaded.view, permissions: [ask, ...rest] } };
  }, [loaded, ask, mode]);

  const send = useCallback(
    async (
      method: "POST" | "DELETE",
      principalUserId: string,
      scope: string,
      opts: { deny?: boolean; days?: number | undefined } = {}
    ) => {
      setBusy(`${principalUserId}|${scope}`);
      setError(null);
      let decided = false;
      try {
        let body: Record<string, unknown>;
        if (mode === "account") {
          const rows = state.status === "ready" ? state.view.permissions : [];
          const target = rows.find((p) => p.principalUserId === principalUserId && p.scope === scope);
          if (method === "POST") {
            body = target?.viaLink
              ? { token: tokenRef.current, ...(opts.days ? { days: opts.days } : {}) }
              : { principalUserId, scope, ...(opts.days ? { days: opts.days } : {}) };
          } else {
            body = opts.deny ? { token: tokenRef.current, deny: true } : { rowId: target?.rowId };
          }
        } else {
          body = { principalUserId, scope, ...(opts.deny ? { deny: true } : {}) };
        }
        const res = await fetch(endpoints.roles, {
          method,
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) setError(res.status === 503 ? UNAVAILABLE_COPY : SAVE_FAILED_COPY);
        else decided = true;
      } catch {
        setError(SAVE_FAILED_COPY);
      }
      // A decided link ask is used up: drop its row and its token (the next ask has a new link).
      if (decided && mode === "account") {
        const target = state.status === "ready" ? state.view.permissions.find((p) => p.principalUserId === principalUserId && p.scope === scope) : undefined;
        if (target?.viaLink) {
          setAsk(null);
          tokenRef.current = null;
        }
      }
      // Re-enable the buttons only after the fresh view has landed.
      await reload();
      if (alive.current) setBusy(null);
    },
    [endpoints.roles, mode, reload, state]
  );

  return {
    state,
    busy,
    error,
    highlight,
    linkInvalid,
    reload,
    allow: (principalUserId, scope, opts) => send("POST", principalUserId, scope, { days: opts?.days }),
    remove: (principalUserId, scope) => send("DELETE", principalUserId, scope),
    dismiss: (principalUserId, scope) => send("DELETE", principalUserId, scope, { deny: true }),
  };
}
