// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/connections-section`
 * Purpose: The customer's "Connections" table (story.0038, connect from home): one row per provider this node's `.cogni/service-links.yaml` lists as a target. Helps a customer admin decide which
 *   provider this node may spend on, and how much. Columns: Node · Offer · Status · Cap · actions. Actions: Connect (a cap in credits) and Disconnect. Same layout, components and table style as
 *   the AI access table.
 * Scope: Presentation over `useConnections`. Renders nothing for a non-admin.
 * Invariants:
 *   - NON_ADMIN_SEES_NOTHING: renders `null` while loading and for every state except a confirmed admin view or a confirmed 503.
 *   - NO_SIGNER_IS_A_STATE: a node with no signing key shows one clear line and offers no Connect; the offer text from config still shows.
 *   - ONE_CLICK_ONE_ACTION: a click in flight replaces that row's actions with a Skeleton; every other click is ignored meanwhile (never dimmed).
 *   - No filters and no extra controls.
 * Side-effects: IO (through the hook)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

"use client";

import { useState } from "react";

import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Skeleton } from "../ui/skeleton.js";
import { CONNECTIONS_UNAVAILABLE_COPY, type ConnectionsEndpoints, NO_SIGNER_COPY, useConnections } from "./use-connections.js";

export interface ConnectionsSectionProps {
  readonly endpoints: ConnectionsEndpoints;
  readonly className?: string;
}

const credits = (n: number): string => n.toLocaleString();

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function ConnectionsSection({ endpoints, className }: ConnectionsSectionProps) {
  const { state, busy, answer, reload, connect, disconnect } = useConnections(endpoints);
  const [caps, setCaps] = useState<Readonly<Record<string, string>>>({});

  // No flash: nothing renders until the server confirms an admin view or a 503.
  if (state.status === "hidden" || state.status === "loading") return null;

  return (
    <section aria-labelledby="connections-heading" className={className}>
      <div className="pt-8 pb-2">
        <h2 id="connections-heading" className="font-semibold text-foreground text-lg">
          Connections
        </h2>
        <div className="mt-2 border-border border-b" />
      </div>

      {state.status === "unavailable" && (
        <p className="flex items-center gap-3 py-3 text-destructive text-sm" role="alert">
          {CONNECTIONS_UNAVAILABLE_COPY}
          <button type="button" className="text-foreground underline" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      )}

      {state.status === "ready" && (
        <div className="py-2">
          {!state.view.signer && (
            <p className="pb-2 text-destructive text-sm" role="alert">
              {NO_SIGNER_COPY}
            </p>
          )}
          {answer && (
            <p className="pb-2 text-foreground text-sm" role="status">
              {answer}
            </p>
          )}
          {state.view.targets.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">No other node is set up for this node to use.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">Node</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Offer</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Status</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Cap</th>
                    {state.view.signer && <th scope="col" className="py-1 text-right font-medium">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {state.view.targets.map((target) => {
                    const saving = busy === target.alias;
                    return (
                      <tr key={target.alias} aria-busy={saving || undefined}>
                        <td className="py-2 pr-3 align-top text-foreground">
                          <span className="font-mono">{target.alias}</span>
                          <div className="text-muted-foreground text-xs">{hostOf(target.origin)}</div>
                        </td>
                        <td className="py-2 pr-3 align-top text-muted-foreground">{target.offer ?? "—"}</td>
                        <td className="whitespace-nowrap py-2 pr-3 align-top text-foreground">{target.status === "connected" ? "Connected" : "Not connected"}</td>
                        <td className="whitespace-nowrap py-2 pr-3 text-right align-top tabular-nums">{target.cap === null ? "—" : credits(target.cap)}</td>
                        {state.view.signer && (
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
                                  placeholder="Cap"
                                  aria-label={`Cap in credits for ${target.alias}`}
                                  value={caps[target.alias] ?? ""}
                                  onChange={(event) => setCaps((prev) => ({ ...prev, [target.alias]: event.target.value }))}
                                />
                                <Button type="button" size="sm" onClick={() => void connect(target.alias, Number(caps[target.alias] ?? ""))}>
                                  Connect
                                </Button>
                                {target.status === "connected" && (
                                  <Button type="button" size="sm" variant="outline" onClick={() => void disconnect(target.alias)}>
                                    Disconnect
                                  </Button>
                                )}
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
