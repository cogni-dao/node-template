// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/use-connected-orgs`
 * Purpose: The data hook behind the provider's "Connected nodes" list (story.0038, connect from home): loads the bounded, paged list, and runs the four row actions (Suspend or Resume, Grant
 *   allowance, Reset seq). The node owns the routes and their auth; this hook only knows the list route and the three `{id}/...` action routes under it.
 * Scope: Plain `fetch` with `cache: "no-store"` and the browser session only (never an Authorization header); no react-query, no kept copy beyond component state.
 * Invariants:
 *   - BOUNDED_PAGED: every read asks `limit=PAGE_SIZE` (50) and, after the first page, `after=<the previous nextAfter>`; a page never holds more than the server's bound.
 *   - KEEPS_LOADED_PAGES: an action reloads EVERY page the admin has loaded (it re-reads each cursor in order), so a click never collapses the table back to its first page.
 *   - FIVE_STATES: `loading` (the section shows a skeleton that mirrors the rows), `ready` with no rows (empty), a few rows (sparse), many rows with paging (dense), and `unavailable` (an error line
 *     with a retry). A 401, 403 or 404 is `hidden` (a signed-out or non-admin caller sees nothing); a 503, any other status, a network error and a malformed body are `unavailable` on a first load.
 *     A later failure keeps an already-ready view (a 503 still shows the error line).
 *   - STALE_RESPONSE_GUARD: each load takes a sequence number; only the newest response is applied.
 *   - ONE_CLICK_ONE_ACTION: while one row's action is in flight every other action is ignored. A grant sends one fresh `Idempotency-Key` per click, so a double click grants once.
 *   - HUMAN_SURFACE_TOKENLESS: no token, key or id is shown. The copy is minimal (a few words per line).
 * Side-effects: IO (fetch)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

"use client";

import type { ConnectedOrgView } from "@cogni/agent-grants";
import { useCallback, useEffect, useRef, useState } from "react";

export interface ConnectedOrgsEndpoints {
  /** The list route (GET `?limit=&after=`), such as `/api/v1/admin/connected-orgs`. The action routes are `{list}/{orgUserId}/allowance`, `.../suspension` and `.../seq-reset` (POST). */
  readonly list: string;
}

export interface ConnectedOrgsPage {
  readonly orgs: readonly ConnectedOrgView[];
  readonly nextAfter: string | null;
}

export type ConnectedOrgsState =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly page: ConnectedOrgsPage };

export interface UseConnectedOrgs {
  readonly state: ConnectedOrgsState;
  /** The `orgUserId` whose action is in flight, else null. */
  readonly busy: string | null;
  /** A one-line message after a failed click; cleared by the next click. */
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  /** Appends the next page. */
  readonly more: () => Promise<void>;
  readonly suspend: (org: ConnectedOrgView) => Promise<void>;
  /** Grants `credits` (a whole number of at least 1). Returns true when it went through. */
  readonly grant: (org: ConnectedOrgView, credits: number) => Promise<boolean>;
  readonly resetSeq: (org: ConnectedOrgView) => Promise<void>;
}

export const CONNECTED_ORGS_PAGE_SIZE = 50;
export const CONNECTED_ORGS_UNAVAILABLE_COPY = "Couldn't load.";
export const CONNECTED_ORGS_ACTION_FAILED_COPY = "Didn't go through.";
export const CONNECTED_ORGS_BAD_AMOUNT_COPY = "Enter a number.";

function isPage(value: unknown): value is ConnectedOrgsPage {
  const v = value as { orgs?: unknown; nextAfter?: unknown } | null;
  return !!v && Array.isArray(v.orgs) && (v.nextAfter === null || typeof v.nextAfter === "string");
}

type PageRead =
  | { readonly kind: "page"; readonly page: ConnectedOrgsPage }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed" };

async function readPage(list: string, after: string | null): Promise<PageRead> {
  try {
    const query = `limit=${CONNECTED_ORGS_PAGE_SIZE}${after === null ? "" : `&after=${encodeURIComponent(after)}`}`;
    const res = await fetch(`${list}?${query}`, { cache: "no-store" });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { kind: "denied" };
    if (res.status === 503) return { kind: "unavailable" };
    if (!res.ok) return { kind: "failed" };
    const body: unknown = await res.json();
    return isPage(body) ? { kind: "page", page: body } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

export function useConnectedOrgs(endpoints: ConnectedOrgsEndpoints): UseConnectedOrgs {
  const { list } = endpoints;
  const [state, setState] = useState<ConnectedOrgsState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  /** The cursor each loaded page started from, in order: `null` is the first page. */
  const starts = useRef<Array<string | null>>([null]);
  const busyRef = useRef<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    const orgs: ConnectedOrgView[] = [];
    let nextAfter: string | null = null;
    for (const after of starts.current) {
      const read = await readPage(list, after);
      if (mine !== sequence.current) return;
      if (read.kind === "denied") return setState({ status: "hidden" });
      if (read.kind === "unavailable") return setState({ status: "unavailable" });
      if (read.kind === "failed") return setState((prev) => (prev.status === "ready" ? prev : { status: "unavailable" }));
      orgs.push(...read.page.orgs);
      nextAfter = read.page.nextAfter;
    }
    setState({ status: "ready", page: { orgs, nextAfter } });
  }, [list]);

  useEffect(() => {
    starts.current = [null];
    void reload();
  }, [reload]);

  const more = useCallback(async (): Promise<void> => {
    if (state.status !== "ready" || state.page.nextAfter === null) return;
    const after = state.page.nextAfter;
    const read = await readPage(list, after);
    if (read.kind !== "page") return setError(CONNECTED_ORGS_UNAVAILABLE_COPY);
    starts.current = [...starts.current, after];
    setState((prev) => (prev.status === "ready" ? { status: "ready", page: { orgs: [...prev.page.orgs, ...read.page.orgs], nextAfter: read.page.nextAfter } } : prev));
  }, [list, state]);

  const act = useCallback(
    async (orgUserId: string, run: () => Promise<Response>): Promise<boolean> => {
      if (busyRef.current !== null) return false;
      busyRef.current = orgUserId;
      setBusy(orgUserId);
      setError(null);
      let ok = false;
      try {
        ok = (await run()).ok;
        if (!ok) setError(CONNECTED_ORGS_ACTION_FAILED_COPY);
      } catch {
        setError(CONNECTED_ORGS_ACTION_FAILED_COPY);
      }
      // Whatever happened, read every loaded page back from the server.
      await reload();
      busyRef.current = null;
      setBusy(null);
      return ok;
    },
    [reload]
  );

  const post = (org: ConnectedOrgView, leaf: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${list}/${encodeURIComponent(org.orgUserId)}/${leaf}`, {
      method: "POST",
      cache: "no-store",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    state,
    busy,
    error,
    reload,
    more,
    suspend: async (org) => {
      await act(org.orgUserId, () => post(org, "suspension", { suspended: org.status !== "suspended" }));
    },
    grant: async (org, credits) => {
      if (!Number.isSafeInteger(credits) || credits < 1) {
        setError(CONNECTED_ORGS_BAD_AMOUNT_COPY);
        return false;
      }
      return act(org.orgUserId, () => post(org, "allowance", { credits }, { "idempotency-key": crypto.randomUUID() }));
    },
    resetSeq: async (org) => {
      await act(org.orgUserId, () => post(org, "seq-reset"));
    },
  };
}
