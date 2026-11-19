// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/use-connections`
 * Purpose: The data hook behind the customer's "Connections" table (story.0038, connect from home): loads the configured providers with this node's own state, and sends one connect (with a cap)
 *   or disconnect. The node owns the route and its auth; this hook knows one path (GET lists, POST acts).
 * Scope: Plain `fetch` with `cache: "no-store"` and the browser session only (never an Authorization header).
 * Invariants:
 *   - SHORT_COPY: every message is a few words ("alias: connected", "alias: stale seq", "No signing key.").
 *   - FIVE_STATES: `loading` (the section shows a skeleton that mirrors the rows), `ready` with no targets (empty), one or two (sparse), many (dense), and `unavailable` (an error line with a retry). A 401,
 *     403 or 404 is `hidden` (a signed-out or non-admin caller sees nothing); a 503, any other status, a network error and a malformed body are `unavailable` on a first load. A later failure keeps an
 *     already-ready view.
 *   - STALE_RESPONSE_GUARD: each load takes a sequence number; only the newest response is applied.
 *   - THE_PROVIDERS_ANSWER_SHOWS: after a click one line says what the provider answered (connected, disconnected or its plain refusal code), never a token.
 *   - RE_READ_AFTER_EVERY_CLICK: whatever the answer (even an unreachable provider, which may have applied the call), the table is read back from the server.
 *   - ONE_CLICK_ONE_ACTION: while an action is in flight every other action is ignored.
 * Side-effects: IO (fetch)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

"use client";

import type { OutboundTargetView } from "@cogni/agent-grants";
import { useCallback, useEffect, useRef, useState } from "react";

export interface ConnectionsEndpoints {
  /** The route: GET lists the configured providers, POST `{ act, alias, cap? }` connects or disconnects, such as `/api/v1/admin/connections`. */
  readonly connections: string;
}

export interface ConnectionsView {
  /** False when this node has no signing key. */
  readonly signer: boolean;
  readonly targets: readonly OutboundTargetView[];
}

export type ConnectionsState =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly view: ConnectionsView };

export interface UseConnections {
  readonly state: ConnectionsState;
  /** The alias whose action is in flight, else null. */
  readonly busy: string | null;
  /** One line about the provider's answer to the last click, or null. */
  readonly answer: string | null;
  readonly reload: () => Promise<void>;
  /** `cap` is a whole number of credits of at least 1. */
  readonly connect: (alias: string, cap: number) => Promise<void>;
  readonly disconnect: (alias: string) => Promise<void>;
}

export const CONNECTIONS_UNAVAILABLE_COPY = "Couldn't load.";
export const NO_SIGNER_COPY = "No signing key.";
export const BAD_CAP_COPY = "Enter a number.";

function isView(value: unknown): value is ConnectionsView {
  const v = value as { signer?: unknown; targets?: unknown } | null;
  return !!v && typeof v.signer === "boolean" && Array.isArray(v.targets);
}

/** One line about the provider's answer to a click, in plain words. `httpStatus` is this node's own route's status. */
export function answerLine(alias: string, body: { status?: unknown; error?: unknown; httpStatus?: unknown } | null, httpStatus: number): string {
  if (body?.status === "connected") return `${alias}: connected`;
  if (body?.status === "disconnected") return `${alias}: off`;
  if (typeof body?.error === "string" && /^[a-z_]{1,40}$/.test(body.error)) {
    if (httpStatus === 404) return `${alias}: unknown`;
    if (httpStatus === 502) return `${alias}: unreachable`;
    if (httpStatus === 503 && body.error === "signer_unavailable") return NO_SIGNER_COPY;
    return `${alias}: ${body.error.replace(/_/g, " ")}`;
  }
  if (typeof body?.httpStatus === "number") return `${alias}: ${body.httpStatus}`;
  return `${alias}: refused`;
}

export function useConnections(endpoints: ConnectionsEndpoints): UseConnections {
  const path = endpoints.connections;
  const [state, setState] = useState<ConnectionsState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const sequence = useRef(0);
  const busyRef = useRef<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (mine !== sequence.current) return;
      if (res.status === 401 || res.status === 403 || res.status === 404) return setState({ status: "hidden" });
      if (res.status === 503) return setState({ status: "unavailable" });
      if (!res.ok) return setState((prev) => (prev.status === "ready" ? prev : { status: "unavailable" }));
      const body: unknown = await res.json();
      if (mine === sequence.current) setState(isView(body) ? { status: "ready", view: body } : (prev) => (prev.status === "ready" ? prev : { status: "unavailable" }));
    } catch {
      if (mine === sequence.current) setState((prev) => (prev.status === "ready" ? prev : { status: "unavailable" }));
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const send = useCallback(
    async (alias: string, body: { act: "connect"; alias: string; cap: number } | { act: "disconnect"; alias: string }): Promise<void> => {
      if (busyRef.current !== null) return;
      busyRef.current = alias;
      setBusy(alias);
      setAnswer(null);
      try {
        const res = await fetch(path, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const parsed: { status?: unknown; error?: unknown; httpStatus?: unknown } | null = await res.json().catch(() => null);
        setAnswer(answerLine(alias, parsed, res.status));
      } catch {
        setAnswer(`${alias}: unreachable`);
      }
      // The provider may have applied the call even when the answer was lost: read the table back either way.
      await reload();
      busyRef.current = null;
      setBusy(null);
    },
    [path, reload]
  );

  return {
    state,
    busy,
    answer,
    reload,
    connect: async (alias, cap) => {
      if (!Number.isSafeInteger(cap) || cap < 1) return setAnswer(BAD_CAP_COPY);
      await send(alias, { act: "connect", alias, cap });
    },
    disconnect: (alias) => send(alias, { act: "disconnect", alias }),
  };
}
