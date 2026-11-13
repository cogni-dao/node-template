// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/use-owner-access`
 * Purpose: The data hook behind the owner's "Your AIs": the person's AIs and what they ask or may do, the by-id Approve and Deny, Off, "Add an AI" (the one-time setup line),
 *   Revoke key, and the claim row a `?claim=<id>` link names.
 * Scope: Plain `fetch` with `cache: "no-store"` and the browser session only (no Authorization header); no kept copy beyond component state. Loads on mount and after every click.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: this hook never sets an Authorization header.
 *   - STALE_RESPONSE_GUARD: each load takes a sequence number; only the newest response is applied.
 *   - SETUP_LINE_SHOWN_ONCE: the setup line (it holds the one-time code) lives only in this hook's state, from the Add click until the person dismisses it or leaves.
 *   - Any failure is a plain notice and never throws. A first load that fails is `unavailable` (with Try again); a later failure keeps the view that is already on screen.
 * Side-effects: IO (fetch)
 * @internal
 */

"use client";

import type { YourAiPermissionView } from "@cogni/agent-grants";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OwnerAccessEndpoints } from "./use-agent-access.js";

export interface OwnedAi {
  readonly agentId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly keyState: "active" | "pending" | "expired" | "revoked" | "none";
}

export interface ClaimRow {
  readonly claimId: string;
  readonly agentName: string | null;
  readonly state: "open" | "claimed" | "expired" | "owned";
}

export type OwnerAccessState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly permissions: readonly YourAiPermissionView[];
      readonly agents: readonly OwnedAi[];
      readonly grantsLeft: number;
    };

const LOAD_FAILED = "Your AIs could not be loaded. Try again in a moment.";
const SAVE_FAILED = "That change could not be saved. Try again in a moment.";
const CLAIM_REFUSALS: Record<string, string> = {
  claim_expired: "This link expired. Ask your AI for a new one.",
  claim_used: "This link was already used.",
  already_owned: "This AI already has an owner.",
  owner_is_agent: "An AI cannot own another AI.",
  too_many_agents: "You already own the most AIs allowed.",
  not_found: "This link was not found.",
};

const init = (extra: RequestInit = {}): RequestInit => ({
  cache: "no-store",
  credentials: "same-origin",
  ...extra,
  headers: { accept: "application/json", ...(extra.headers ?? {}) },
});
const jsonInit = (method: string, body: unknown): RequestInit => init({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const readJson = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

export interface UseOwnerAccess {
  readonly state: OwnerAccessState;
  /** The claim a `?claim=<id>` link names, when it exists. */
  readonly claim: ClaimRow | null;
  /** The row of a click in flight (a request id, `agent:<id>`, `add` or `claim`), else null. While set, every button is disabled. */
  readonly busy: string | null;
  readonly error: string | null;
  readonly setupLine: string | null;
  readonly reload: () => Promise<void>;
  readonly decide: (requestId: string, decision: "approve" | "deny") => Promise<void>;
  readonly turnOff: (principalUserId: string, scope: string, requestId: string) => Promise<void>;
  readonly addAi: () => Promise<void>;
  readonly dismissSetupLine: () => void;
  readonly revokeAi: (agentId: string) => Promise<void>;
  readonly completeClaim: () => Promise<void>;
}

export function useOwnerAccess(endpoints: OwnerAccessEndpoints, highlightId: string | undefined): UseOwnerAccess {
  const [state, setState] = useState<OwnerAccessState>({ status: "loading" });
  const [claim, setClaim] = useState<ClaimRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupLine, setSetupLine] = useState<string | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);
  const current = useRef<OwnerAccessState>({ status: "loading" });

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [permsRes, aisRes] = await Promise.all([fetch(endpoints.mine, init()), fetch(endpoints.ais, init())]);
      if (!alive.current || mine !== seq.current) return;
      const perms = permsRes.ok ? ((await readJson(permsRes)) as { permissions?: unknown } | null) : null;
      const ais = aisRes.ok ? ((await readJson(aisRes)) as { agents?: unknown; grantsLeft?: unknown } | null) : null;
      if (!alive.current || mine !== seq.current) return;
      if (!Array.isArray(perms?.permissions) || !Array.isArray(ais?.agents)) throw new Error("bad_body");
      const next: OwnerAccessState = {
        status: "ready",
        permissions: perms.permissions as YourAiPermissionView[],
        agents: ais.agents as OwnedAi[],
        grantsLeft: typeof ais.grantsLeft === "number" ? ais.grantsLeft : 0,
      };
      current.current = next;
      setState(next);
    } catch {
      if (!alive.current || mine !== seq.current) return;
      // A later failure keeps the view on screen; a first load that fails says so, with Try again.
      if (current.current.status !== "ready") {
        current.current = { status: "unavailable" };
        setState(current.current);
      } else setError(LOAD_FAILED);
    }
  }, [endpoints.mine, endpoints.ais]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  // A `?claim=<id>` link: when the id is not one of the rows on screen, ask whether it names a claim.
  const rowIds = state.status === "ready" ? state.permissions.map((p) => p.requestId).join(",") : null;
  useEffect(() => {
    if (!highlightId || rowIds === null || rowIds.split(",").includes(highlightId)) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${endpoints.claims}/${encodeURIComponent(highlightId)}`, init());
        const body = res.ok ? ((await readJson(res)) as Partial<ClaimRow> | null) : null;
        if (!cancelled && body && typeof body.state === "string" && typeof body.claimId === "string")
          setClaim({ claimId: body.claimId, agentName: body.agentName ?? null, state: body.state });
      } catch {
        // No claim row; the page shows what it has.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [highlightId, rowIds, endpoints.claims]);

  const act = useCallback(
    async (key: string, call: () => Promise<Response>, refused?: (res: Response) => Promise<string | null>) => {
      setBusy(key);
      setError(null);
      try {
        const res = await call();
        if (!res.ok) setError((refused ? await refused(res) : null) ?? SAVE_FAILED);
      } catch {
        setError(SAVE_FAILED);
      }
      // Re-enable the buttons only after the fresh view has landed.
      await reload();
      if (alive.current) setBusy(null);
    },
    [reload]
  );

  return {
    state,
    claim,
    busy,
    error,
    setupLine,
    reload,
    decide: (requestId, decision) =>
      act(requestId, () => fetch(`${endpoints.requests}/${encodeURIComponent(requestId)}`, jsonInit("POST", { decision })), async (res) =>
        res.status === 409 ? "That ask was already decided." : null
      ),
    turnOff: (principalUserId, scope, requestId) => act(requestId, () => fetch(endpoints.mine, jsonInit("DELETE", { principalUserId, scope }))),
    addAi: async () => {
      setBusy("add");
      setError(null);
      try {
        const res = await fetch(endpoints.ais, init({ method: "POST" }));
        const body = (await readJson(res)) as { setupLine?: unknown; error?: unknown } | null;
        if (res.ok && typeof body?.setupLine === "string") setSetupLine(body.setupLine);
        else setError(body?.error === "too_many_pending" ? "You already have 5 unused setup lines. Use one, or wait for it to expire." : "A setup line could not be made. Try again in a moment.");
      } catch {
        setError("A setup line could not be made. Try again in a moment.");
      }
      await reload();
      if (alive.current) setBusy(null);
    },
    dismissSetupLine: () => setSetupLine(null),
    revokeAi: (agentId) => act(`agent:${agentId}`, () => fetch(endpoints.aisRevoke, jsonInit("POST", { agentId }))),
    completeClaim: async () => {
      if (!claim) return;
      setBusy("claim");
      setError(null);
      try {
        const res = await fetch(`${endpoints.claims}/${encodeURIComponent(claim.claimId)}`, init({ method: "POST" }));
        if (!res.ok) {
          const body = (await readJson(res)) as { error?: string } | null;
          setError(CLAIM_REFUSALS[body?.error ?? ""] ?? SAVE_FAILED);
        } else setClaim(null);
      } catch {
        setError(SAVE_FAILED);
      }
      await reload();
      if (alive.current) setBusy(null);
    },
  };
}
