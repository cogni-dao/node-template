// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/PayoutProfile.client`
 * Purpose: The profile's "Payout": the person's own payout address (separate from the wallet they sign in with) and the AIs whose earnings they accepted.
 *   An AI's one-time link (`/profile#beneficiary=<token>`) opens an accept prompt here.
 * Scope: Client mount only. It reads the link token once from the URL fragment and removes it at once; the routes decide everything.
 * Invariants: AUTH_IS_NOT_PAYMENT (the address is typed here, never copied from the sign-in wallet), BENEFICIARY_IS_ACCEPTED (an AI is paid to this person only after this click),
 *   HUMAN_ROUTES_SESSION_ONLY (the page sends the browser session only).
 * Side-effects: IO (fetch), history.replaceState (strips the token)
 * Links: src/app/api/v1/identity/payout-address/route.ts, src/app/api/v1/identity/beneficiary/mine/route.ts
 * @internal
 */

"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Button, Input } from "@/components";

const ADDRESS_PATH = "/api/v1/identity/payout-address";
const MINE_PATH = "/api/v1/identity/beneficiary/mine";
const PREVIEW_PATH = "/api/v1/identity/beneficiary/mine/preview";
const FRAGMENT_KEY = "beneficiary";

interface Mine {
  id: string;
  earnerName: string | null;
  earnerUserId: string;
}

/** Read `#beneficiary=<token>` once and remove it from the address bar, leaving any other fragment value as it was. */
function takeFragmentToken(): string | null {
  const parts = window.location.hash.replace(/^#/, "").split("&").filter(Boolean);
  const hit = parts.find((p) => p.startsWith(`${FRAGMENT_KEY}=`));
  if (!hit) return null;
  const rest = parts.filter((p) => p !== hit).join("&");
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`);
  return hit.slice(FRAGMENT_KEY.length + 1);
}

export function PayoutProfile(): ReactElement {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  // What the link names: undefined while loading, null for a bad or expired link, else the AI's display name (null name = unnamed).
  const [offer, setOffer] = useState<{ name: string | null } | null | undefined>(undefined);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [mine, setMine] = useState<Mine[]>([]);

  const load = useCallback(async () => {
    const [a, m] = await Promise.all([fetch(ADDRESS_PATH), fetch(MINE_PATH)]);
    if (a.ok) setSaved(((await a.json()) as { address: string | null }).address);
    if (m.ok) setMine(((await m.json()) as { beneficiaries: Mine[] }).beneficiaries);
  }, []);

  useEffect(() => {
    const found = takeFragmentToken();
    setToken(found);
    void load();
    if (!found) return;
    void fetch(PREVIEW_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: found }) })
      .then((res) => (res.ok ? (res.json() as Promise<{ valid: boolean; earnerName?: string | null }>) : null))
      .then((p) => setOffer(p?.valid ? { name: p.earnerName ?? null } : null))
      .catch(() => setOffer(null));
  }, [load]);

  const save = async () => {
    const res = await fetch(ADDRESS_PATH, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: draft.trim() }) });
    setNote(res.ok ? null : "That is not a valid address.");
    if (res.ok) {
      setDraft("");
      await load();
    }
  };

  const decide = async (method: "POST" | "DELETE", body: object) => {
    const res = await fetch(MINE_PATH, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = res.ok ? ((await res.json()) as { accepted?: boolean }) : null;
    if (method === "POST") setLinkNote(result?.accepted ? null : "That link is no longer valid. Ask the AI for a new one.");
    setToken(null);
    await load();
  };

  return (
    <div className="py-5">
      <div className="pt-8 pb-2">
        <h2 className="font-semibold text-foreground text-lg">Payout</h2>
        <div className="mt-2 border-border border-b" />
      </div>
      <p className="py-3 text-muted-foreground text-sm">
        Where your earnings are paid. This is separate from the wallet you sign in with; with no address set, your earnings are held.
      </p>
      <div className="text-foreground text-sm">{saved ? `Payout address: ${saved}` : "No payout address set."}</div>
      <div className="flex gap-2 py-3">
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="0x..." aria-label="Payout address" />
        <Button variant="outline" onClick={() => void save()} disabled={!draft.trim()}>
          Save
        </Button>
      </div>
      {note && <div className="text-destructive text-sm">{note}</div>}
      {token && offer === null && <div className="py-3 text-destructive text-sm">That link is invalid or has expired. Ask the AI for a new one.</div>}
      {token && offer && (
        <div className="py-3">
          <div className="text-foreground text-sm">
            {offer.name ?? "An AI account"} asks to send its earnings to you. Its work stays credited to the AI; only claims finalized after you accept are paid to you.
          </div>
          <div className="flex gap-2 pt-2">
            <Button onClick={() => void decide("POST", { token })}>Accept</Button>
            <Button variant="ghost" onClick={() => setToken(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {linkNote && <div className="py-3 text-destructive text-sm">{linkNote}</div>}
      {mine.map((row) => (
        <div key={row.id} className="flex items-center justify-between py-2 text-sm">
          <span>Earnings of {row.earnerName ?? row.earnerUserId} are paid to you.</span>
          <Button variant="ghost" size="sm" onClick={() => void decide("DELETE", { id: row.id })}>
            Stop
          </Button>
        </div>
      ))}
    </div>
  );
}
