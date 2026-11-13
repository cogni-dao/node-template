// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/ai-access/requests/[id]/RequestApproval.client`
 * Purpose: The node-admin's page for ONE ask: the AI, who owns it, the permission in plain words, Approve and Deny. Nothing else.
 * Scope: Client component over the admin-area routes: GET `/api/v1/admin/ai-access/requests/{id}` to read, the admin `ai-access` POST and DELETE to decide (each re-checks admin).
 *   Opening the page never approves.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN: this control lives in the Admin area only. HUMAN_ROUTES_SESSION_ONLY: the browser session only.
 *   - HUMAN_SURFACE_TOKENLESS: the text holds names and the declared description, no token, id, key, scope string or API path.
 *   - A request this admin may not decide, or that does not exist, is one plain "not found".
 * Side-effects: IO (fetch)
 * @public
 */

"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components";

interface View {
  principalUserId: string;
  scope: string;
  who: string;
  owner: string | null;
  label: string;
  description: string;
  state: "pending" | "granted" | "denied" | "revoked" | "ended";
  until: string | null;
}

const STATE_TEXT: Record<View["state"], string> = {
  pending: "Waiting for a decision.",
  granted: "On.",
  denied: "Dismissed.",
  revoked: "Turned off.",
  ended: "It ended.",
};

const DECIDE = "/api/v1/admin/ai-access";

export function RequestApproval({ requestId }: { requestId: string }): ReactElement {
  const url = `/api/v1/admin/ai-access/requests/${encodeURIComponent(requestId)}`;
  const [view, setView] = useState<View | null | "missing">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(url, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
      if (res.status === 404 || res.status === 403 || res.status === 401) return setView("missing");
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

  const send = async (method: "POST" | "DELETE", deny = false): Promise<void> => {
    if (view === null || view === "missing") return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(DECIDE, {
        method,
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ principalUserId: view.principalUserId, scope: view.scope, ...(deny ? { deny: true } : {}) }),
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
      <p className="text-muted-foreground text-xs">{view.owner ? `Owner: ${view.owner}` : "No owner"}</p>
      <p className="text-foreground text-sm">{STATE_TEXT[view.state]}</p>
      {notice && <p className="text-destructive text-sm">{notice}</p>}
      {view.state === "pending" && (
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void send("POST")}>
            Approve
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void send("DELETE", true)}>
            Deny
          </Button>
        </div>
      )}
      {view.state === "granted" && (
        <Button variant="outline" disabled={busy} onClick={() => void send("DELETE")}>
          Turn off
        </Button>
      )}
    </section>
  );
}
