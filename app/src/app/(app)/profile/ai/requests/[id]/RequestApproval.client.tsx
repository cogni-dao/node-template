// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/ai/requests/[id]/RequestApproval.client`
 * Purpose: The owner's page for ONE ask an AI of theirs made: the AI, the permission in plain words, Approve and Deny. Nothing else.
 * Scope: Client component over the session-only `/api/v1/agent-access/mine/requests/{id}`. Opening the page never approves: only the Approve click does. Imports nothing from the Admin area.
 * Invariants:
 *   - HUMAN_SURFACE_TOKENLESS: the text holds names and the declared description, no token, id, key, scope string or API path.
 *   - ONE_CONTROL_ONE_DECISION: Approve and Deny ask once and never confirm; the owner can later turn it Off on the profile.
 *   - A request that is not theirs, or does not exist, is one plain "not found". A bad answer shows a plain notice and never throws.
 * Side-effects: IO (fetch)
 * @public
 */

"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components";

interface View {
  who: string;
  label: string;
  description: string;
  state: "pending" | "granted" | "denied" | "revoked" | "ended";
  until: string | null;
}

const STATE_TEXT: Record<View["state"], string> = {
  pending: "Waiting for your decision.",
  granted: "On.",
  denied: "You said no.",
  revoked: "Turned off.",
  ended: "It ended. The AI can ask again.",
};

export function RequestApproval({ requestId }: { requestId: string }): ReactElement {
  const url = `/api/v1/agent-access/mine/requests/${encodeURIComponent(requestId)}`;
  const [view, setView] = useState<View | null | "missing">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(url, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
      if (res.status === 404) return setView("missing");
      const body = res.ok ? ((await res.json().catch(() => null)) as View | null) : null;
      if (body && typeof body.who === "string") return setView(body);
      setNotice("This request could not be loaded. Try again in a moment.");
    } catch {
      setNotice("This request could not be loaded. Try again in a moment.");
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) setNotice(res.status === 409 ? "This request was already decided." : "That could not be saved. Try again in a moment.");
    } catch {
      setNotice("That could not be saved. Try again in a moment.");
    }
    await load();
    setBusy(false);
  };

  if (view === null) return <p className="py-6 text-muted-foreground text-sm">{notice ?? "Loading"}</p>;
  if (view === "missing") return <p className="py-6 text-foreground text-sm">This request was not found.</p>;

  return (
    <section aria-labelledby="request-heading" className="space-y-4 py-6">
      <h1 id="request-heading" className="font-semibold text-foreground text-lg">
        &ldquo;{view.who}&rdquo; asks to: {view.label}
      </h1>
      <p className="text-muted-foreground text-sm">{view.description}</p>
      <p className="text-foreground text-sm">
        {STATE_TEXT[view.state]}
        {view.state === "granted" && view.until ? ` Ends ${new Date(view.until).toLocaleDateString()}.` : ""}
      </p>
      {notice && <p className="text-destructive text-sm">{notice}</p>}
      {view.state === "pending" && (
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void decide("approve")}>
            Approve
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void decide("deny")}>
            Deny
          </Button>
        </div>
      )}
    </section>
  );
}
