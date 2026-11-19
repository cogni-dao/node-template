// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/connected-orgs-section`
 * Purpose: The provider's "Connected orgs" table (story.0038, connect from home): one row per customer node that connected to this node. Helps a provider admin decide how much each may spend
 *   and whether to stop one. Columns: Org · Status · Allowance · Used / cap · Last call · actions. Actions: Grant allowance (a number of credits), Suspend or Resume, Reset seq.
 *   Same layout, components and table style as the AI access table.
 * Scope: Presentation over `useConnectedOrgs`. Renders nothing for a non-admin.
 * Invariants:
 *   - NON_ADMIN_SEES_NOTHING: renders `null` while loading and for every state except a confirmed admin view or a confirmed 503. No heading or skeleton shows to a non-admin.
 *   - ONE_CLICK_ONE_ACTION: a click in flight replaces that row's actions with a Skeleton; every other click is ignored meanwhile (never dimmed).
 *   - HUMAN_SURFACE_TOKENLESS: the text holds no token, id, key or API path.
 *   - No filters and no extra controls: a "More" link appears only when the server says there is another page.
 * Side-effects: IO (through the hook)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

"use client";

import type { ConnectedOrgView } from "@cogni/agent-grants";
import { useState } from "react";

import { cn } from "../cn.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Skeleton } from "../ui/skeleton.js";
import { CONNECTED_ORGS_UNAVAILABLE_COPY, type ConnectedOrgsEndpoints, useConnectedOrgs } from "./use-connected-orgs.js";

export interface ConnectedOrgsSectionProps {
  readonly endpoints: ConnectedOrgsEndpoints;
  readonly className?: string;
}

const STATUS_LABEL: Record<ConnectedOrgView["status"], string> = { connected: "Connected", suspended: "Suspended", disconnected: "Disconnected" };

const credits = (n: number): string => n.toLocaleString();

/** The issuer's host, shown as the org's name; the raw text if it is not a URL. */
function hostOf(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

/** A date for the last billed call: day and month, from the ISO the server sent. */
function lastCall(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ConnectedOrgsSection({ endpoints, className }: ConnectedOrgsSectionProps) {
  const { state, busy, error, reload, more, suspend, grant, resetSeq } = useConnectedOrgs(endpoints);
  const [amounts, setAmounts] = useState<Readonly<Record<string, string>>>({});

  // No flash: nothing renders until the server confirms an admin view or a 503.
  if (state.status === "hidden" || state.status === "loading") return null;

  const grantFor = async (org: ConnectedOrgView): Promise<void> => {
    const ok = await grant(org, Number(amounts[org.orgUserId] ?? ""));
    if (ok) setAmounts((prev) => ({ ...prev, [org.orgUserId]: "" }));
  };

  return (
    <section aria-labelledby="connected-orgs-heading" className={className}>
      <div className="pt-8 pb-2">
        <h2 id="connected-orgs-heading" className="font-semibold text-foreground text-lg">
          Connected orgs
        </h2>
        <div className="mt-2 border-border border-b" />
      </div>

      {state.status === "unavailable" && (
        <p className="flex items-center gap-3 py-3 text-destructive text-sm" role="alert">
          {CONNECTED_ORGS_UNAVAILABLE_COPY}
          <button type="button" className="text-foreground underline" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      )}

      {state.status === "ready" && (
        <div className="py-2">
          {error && (
            <p className="pb-2 text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          {state.page.orgs.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">No node has connected yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">Org</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Status</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Allowance</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Used / cap</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Last call</th>
                    <th scope="col" className="py-1 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {state.page.orgs.map((org) => {
                    const saving = busy === org.orgUserId;
                    return (
                      <tr key={org.orgUserId} aria-busy={saving || undefined}>
                        <td className="py-2 pr-3 align-top text-foreground">
                          <span className="font-mono">{hostOf(org.issuer)}</span>
                          {org.nodeId && <div className="text-muted-foreground text-xs">Node {org.nodeId}</div>}
                        </td>
                        <td className={cn("whitespace-nowrap py-2 pr-3 align-top", org.status === "suspended" ? "text-destructive" : "text-foreground")}>
                          {STATUS_LABEL[org.status]}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 text-right align-top tabular-nums">{credits(org.allowance)}</td>
                        <td className="whitespace-nowrap py-2 pr-3 text-right align-top text-muted-foreground tabular-nums">
                          {credits(org.debits)} / {credits(org.cap)}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 align-top text-muted-foreground">{lastCall(org.lastCallAt)}</td>
                        <td className="py-2 align-top">
                          {saving ? (
                            <>
                              <Skeleton className="ml-auto h-9 w-40" />
                              <span className="sr-only" role="status">Saving</span>
                            </>
                          ) : (
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={1}
                                step={1}
                                className="w-28"
                                placeholder="Credits"
                                aria-label={`Allowance to grant ${hostOf(org.issuer)}`}
                                value={amounts[org.orgUserId] ?? ""}
                                onChange={(event) => setAmounts((prev) => ({ ...prev, [org.orgUserId]: event.target.value }))}
                              />
                              <Button type="button" size="sm" onClick={() => void grantFor(org)}>
                                Grant allowance
                              </Button>
                              <Button type="button" size="sm" variant="outline" onClick={() => void suspend(org)}>
                                {org.status === "suspended" ? "Resume" : "Suspend"}
                              </Button>
                              <Button type="button" size="sm" variant="outline" onClick={() => void resetSeq(org)}>
                                Reset seq
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {state.page.nextAfter && (
            <button type="button" className="pt-3 text-foreground text-sm underline" onClick={() => void more()}>
              More
            </button>
          )}
        </div>
      )}
    </section>
  );
}
