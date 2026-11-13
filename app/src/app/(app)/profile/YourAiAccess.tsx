// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/YourAiAccess`
 * Purpose: What the AIs a person made ask to do with THEIR data, inside "Your AIs": one row per ask or grant (Who, Can do, Until, On). The person turns a row On
 *   (it ends after 30 days), and later Off, by clicking. An AI's ask shows as Off until they say yes.
 * Scope: Client component over the session-only `/api/v1/agent-access/mine` route. Lists personal permissions only. No node-wide switch and no node permission:
 *   those stay in /admin (ADMIN_ACTS_IN_ADMIN, APPROVER_FOLLOWS_RESOURCE). It imports nothing from the Admin area.
 * Invariants:
 *   - ONE_CONTROL_ONE_DECISION: the switch is the whole decision, both directions. No confirm step. An ask also has an x that dismisses it.
 *   - HUMAN_SURFACE_TOKENLESS: the text holds no token, id, key, scope string or API path. The ids stay in memory as the handles a click sends back.
 *   - Plain `fetch` with `no-store` and the browser session only: no Authorization header. A bad or missing answer shows a plain notice and never throws.
 *   - A row with a click in flight shows a skeleton, never a dimmed switch. Another row's switch ignores clicks until the fresh list has landed.
 * Side-effects: IO (fetch to /api/v1/agent-access/mine)
 * Links: src/app/api/v1/agent-access/mine/route.ts, https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

"use client";

import { Skeleton } from "@cogni/node-ui-kit/shadcn/skeleton";
import { cn } from "@cogni/node-ui-kit/util/cn";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

interface Row {
  principalUserId: string;
  who: string;
  scope: string;
  label: string;
  description: string;
  on: boolean;
  until: string | null;
}

const MINE = "/api/v1/agent-access/mine";
const LOAD_FAILED = "What your AIs ask for could not be loaded. Try again in a moment.";
const SAVE_FAILED = "That change could not be saved. Try again in a moment.";

function parseRows(body: unknown): Row[] | null {
  const permissions = (body as { permissions?: unknown } | null)?.permissions;
  return Array.isArray(permissions) ? (permissions as Row[]) : null;
}

const keyOf = (row: Row): string => `${row.principalUserId}|${row.scope}`;

export function YourAiAccess(): ReactElement | null {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(MINE, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
      const parsed = res.ok ? parseRows(await res.json().catch(() => null)) : null;
      if (!parsed) {
        setRows((current) => current ?? []);
        setNotice(LOAD_FAILED);
        return;
      }
      setRows(parsed);
    } catch {
      setRows((current) => current ?? []);
      setNotice(LOAD_FAILED);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (row: Row, method: "POST" | "DELETE", deny = false): Promise<void> => {
    setBusy(keyOf(row));
    setNotice(null);
    try {
      const res = await fetch(MINE, {
        method,
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ principalUserId: row.principalUserId, scope: row.scope, ...(deny ? { deny: true } : {}) }),
      });
      if (!res.ok) setNotice(SAVE_FAILED);
    } catch {
      setNotice(SAVE_FAILED);
    }
    await load();
    setBusy(null);
  };

  // Nothing to decide: show no table. (A load failure still shows its notice.)
  if (rows === null) return null;
  if (rows.length === 0 && !notice) return null;

  return (
    <div className="py-3">
      <h3 className="pb-1 font-medium text-foreground text-sm">What your AIs ask to do</h3>
      {notice && (
        <p className="pb-2 text-destructive text-sm" role="alert">
          {notice}
        </p>
      )}
      {rows.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">Who</th>
              <th scope="col" className="py-1 pr-3 font-medium">Can do</th>
              <th scope="col" className="py-1 pr-3 font-medium">Until</th>
              <th scope="col" className="w-20 py-1 text-right font-medium">On</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const saving = busy === keyOf(row);
              return (
                <tr key={keyOf(row)} aria-busy={saving || undefined}>
                  <td className="py-2 pr-3 align-top text-foreground">&ldquo;{row.who}&rdquo;</td>
                  <td className="py-2 pr-3 align-top">
                    <div className="text-foreground">{row.label}</div>
                    <div className="text-muted-foreground text-xs">{row.description}</div>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 align-top text-muted-foreground">
                    {row.until ? new Date(row.until).toLocaleDateString() : "—"}
                  </td>
                  <td className="h-10 py-2 text-right align-top">
                    {saving ? (
                      <>
                        <Skeleton className="ml-auto h-5 w-9 rounded-full" />
                        <span className="sr-only" role="status">Saving</span>
                      </>
                    ) : (
                      <span className="inline-flex items-center justify-end gap-2">
                        <Switch
                          on={row.on}
                          label={`${row.who}: ${row.label}`}
                          locked={busy !== null}
                          onToggle={() => void (row.on ? send(row, "DELETE") : send(row, "POST"))}
                        />
                        {!row.on && (
                          <button
                            type="button"
                            aria-label={`Dismiss the ask: ${row.who}: ${row.label}`}
                            aria-disabled={busy !== null || undefined}
                            className="px-1 text-muted-foreground hover:text-foreground"
                            onClick={() => {
                              if (busy === null) void send(row, "DELETE", true);
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** A small switch. `locked` ignores clicks while another row saves; it never dims the switch. */
function Switch(props: { on: boolean; label: string; locked: boolean; onToggle: () => void }): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      aria-disabled={props.locked || undefined}
      onClick={() => {
        if (!props.locked) props.onToggle();
      }}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        props.on ? "bg-primary" : "bg-input"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow transition-transform",
          props.on ? "translate-x-4" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
