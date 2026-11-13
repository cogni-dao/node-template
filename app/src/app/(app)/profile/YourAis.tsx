// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/YourAis`
 * Purpose: The "Your AIs" block on a person's own profile. Lists the AIs this person made (name, when, key state), lets them Revoke one,
 *   and "Add an AI" shows ONE copyable setup line for a new AI.
 * Scope: Client component over the session-only `/api/v1/profile/ai` routes. No node-wide switch, no node permission, no admin control: those
 *   stay in /admin (ADMIN_ACTS_IN_ADMIN, APPROVER_FOLLOWS_RESOURCE). It imports nothing from the Admin area.
 * Invariants:
 *   - HUMAN_SURFACE_TOKENLESS: the list prints no key, id, hash or path. The setup line (it holds the one-time code) appears only right after the
 *     Add click, in a field the person copies from, and is dropped from memory when they dismiss it or leave.
 *   - Revoke never asks (page rule). Plain `fetch` with `no-store` and the browser session only: no Authorization header.
 *   - A bad or missing answer shows a plain notice and never throws.
 *   - What an AI asks to do with the person's own data (their personal permissions) is `YourAiAccess`, below the list. Still no node permission here.
 * Side-effects: IO (fetch to /api/v1/profile/ai and /api/v1/profile/ai/revoke)
 * Links: src/app/api/v1/profile/ai/route.ts, https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components";

import { YourAiAccess } from "./YourAiAccess";

interface OwnedAi {
  agentId: string;
  name: string;
  createdAt: string;
  keyState: "active" | "pending" | "expired" | "revoked" | "none";
}

const KEY_STATE_TEXT: Record<OwnedAi["keyState"], string> = {
  active: "Key active",
  pending: "Waiting for the AI to confirm its key",
  expired: "Key expired",
  revoked: "Key revoked",
  none: "No key",
};

const LIST = "/api/v1/profile/ai";
const REVOKE = "/api/v1/profile/ai/revoke";

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function parseList(body: unknown): { agents: OwnedAi[]; grantsLeft: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const { agents, grantsLeft } = body as { agents?: unknown; grantsLeft?: unknown };
  if (!Array.isArray(agents) || typeof grantsLeft !== "number") return null;
  return { agents: agents as OwnedAi[], grantsLeft };
}

export function YourAis(): ReactElement {
  const [agents, setAgents] = useState<OwnedAi[] | null>(null);
  const [grantsLeft, setGrantsLeft] = useState<number>(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [setupLine, setSetupLine] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(LIST, { cache: "no-store" });
      const parsed = res.ok ? parseList(await readJson(res)) : null;
      if (!parsed) {
        setAgents([]);
        setNotice("Your AIs could not be loaded. Try again in a moment.");
        return;
      }
      setAgents(parsed.agents);
      setGrantsLeft(parsed.grantsLeft);
    } catch {
      setAgents([]);
      setNotice("Your AIs could not be loaded. Try again in a moment.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (): Promise<void> => {
    setBusy("add");
    setNotice(null);
    try {
      const res = await fetch(LIST, { method: "POST", cache: "no-store" });
      const body = (await readJson(res)) as { setupLine?: unknown; error?: unknown } | null;
      if (res.ok && typeof body?.setupLine === "string") {
        setSetupLine(body.setupLine);
        await load();
      } else {
        setNotice(
          body?.error === "too_many_pending"
            ? "You already have 5 unused setup lines. Use one, or wait for it to expire."
            : "A setup line could not be made. Try again in a moment."
        );
      }
    } catch {
      setNotice("A setup line could not be made. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (agentId: string): Promise<void> => {
    setBusy(agentId);
    setNotice(null);
    try {
      const res = await fetch(REVOKE, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) setNotice("That AI could not be revoked. Try again in a moment.");
      await load();
    } catch {
      setNotice("That AI could not be revoked. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const copy = (): void => {
    if (setupLine) void navigator.clipboard?.writeText(setupLine).catch(() => undefined);
  };

  return (
    <div className="py-5">
      <p className="text-muted-foreground text-sm">
        AIs you made act for you here. You can end an AI&apos;s access at any time.
      </p>

      {agents === null ? (
        <p className="py-3 text-muted-foreground text-sm">Loading</p>
      ) : agents.length === 0 ? (
        <p className="py-3 text-muted-foreground text-sm">You have not added an AI yet.</p>
      ) : (
        <ul className="divide-y divide-border py-2">
          {agents.map((ai) => (
            <li key={ai.agentId} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground text-sm">{ai.name}</div>
                <div className="text-muted-foreground text-xs">
                  Added {new Date(ai.createdAt).toLocaleDateString()} · {KEY_STATE_TEXT[ai.keyState]}
                </div>
              </div>
              {(ai.keyState === "active" || ai.keyState === "pending") && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  aria-label={`Revoke ${ai.name}`}
                  onClick={() => void revoke(ai.agentId)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {setupLine && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-foreground text-sm">
            Give this line to your AI. It works once and is shown only now.
          </p>
          <textarea
            readOnly
            aria-label="Setup line for your AI"
            value={setupLine}
            rows={4}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={copy}>
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSetupLine(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {notice && <p className="pt-2 text-destructive text-sm">{notice}</p>}

      <YourAiAccess />

      <div className="pt-3">
        <Button variant="outline" disabled={busy !== null || grantsLeft === 0} onClick={() => void add()}>
          Add an AI
        </Button>
      </div>
    </div>
  );
}
