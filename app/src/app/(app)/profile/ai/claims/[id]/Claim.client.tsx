// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/ai/claims/[id]/Claim.client`
 * Purpose: The page an existing AI's claim link opens: "This AI asks to be yours" and one Claim click.
 * Scope: Client component over the session-only `/api/v1/profile/ai/claims/{id}`. Opening the page claims nothing: only the click does. Imports nothing from the Admin area.
 * Invariants:
 *   - HUMAN_SURFACE_TOKENLESS: the text holds the AI's name only. The claim id stays in the path.
 *   - A claim that is unknown, used, expired or already owned says so plainly. A bad answer shows a plain notice and never throws.
 * Side-effects: IO (fetch)
 * @public
 */

"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components";

interface View {
  agentName: string | null;
  state: "open" | "claimed" | "expired" | "owned";
}

const CLICK_FAILED: Record<string, string> = {
  claim_expired: "This link expired. Ask your AI for a new one.",
  claim_used: "This link was already used.",
  already_owned: "This AI already has an owner.",
  owner_is_agent: "An AI cannot own another AI.",
  too_many_agents: "You already own the most AIs allowed.",
  not_found: "This link was not found.",
};

export function Claim({ claimId }: { claimId: string }): ReactElement {
  const url = `/api/v1/profile/ai/claims/${encodeURIComponent(claimId)}`;
  const [view, setView] = useState<View | null | "missing">(null);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(url, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
      if (res.status === 404) return setView("missing");
      const body = res.ok ? ((await res.json().catch(() => null)) as View | null) : null;
      if (body && typeof body.state === "string") return setView(body);
      setNotice("This link could not be loaded. Try again in a moment.");
    } catch {
      setNotice("This link could not be loaded. Try again in a moment.");
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(url, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
      if (res.ok) setDone(true);
      else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setNotice(CLICK_FAILED[body?.error ?? ""] ?? "That could not be saved. Try again in a moment.");
      }
    } catch {
      setNotice("That could not be saved. Try again in a moment.");
    }
    setBusy(false);
  };

  if (view === null) return <p className="py-6 text-muted-foreground text-sm">{notice ?? "Loading"}</p>;
  if (view === "missing") return <p className="py-6 text-foreground text-sm">This link was not found.</p>;
  const name = view.agentName ?? "An AI";

  return (
    <section aria-labelledby="claim-heading" className="space-y-4 py-6">
      <h1 id="claim-heading" className="font-semibold text-foreground text-lg">
        &ldquo;{name}&rdquo; asks to be your AI
      </h1>
      {done ? (
        <p className="text-foreground text-sm">Done. It is now one of Your AIs on your profile.</p>
      ) : view.state === "open" ? (
        <>
          <p className="text-muted-foreground text-sm">If you claim it, you can turn on what it may do for you, and end its access at any time.</p>
          {notice && <p className="text-destructive text-sm">{notice}</p>}
          <Button disabled={busy} onClick={() => void claim()}>
            Claim this AI
          </Button>
        </>
      ) : (
        <p className="text-foreground text-sm">
          {view.state === "expired" ? CLICK_FAILED.claim_expired : view.state === "claimed" ? CLICK_FAILED.claim_used : CLICK_FAILED.already_owned}
        </p>
      )}
    </section>
  );
}
