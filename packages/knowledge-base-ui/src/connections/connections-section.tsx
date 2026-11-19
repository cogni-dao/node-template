// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/connections-section`
 * Purpose: Helps a customer admin decide which other nodes this node's AI may spend on, and how much. The "Connections" table (story.0038, connect from home).
 *   Columns Node · Limit · On, the same table, heading and switch as the AI access table. The limit is this node's spend control, in dollars.
 * Scope: Presentation over `useConnections`. Money is dollars through the injected `Money`. Words are kept to the minimum: the provider's offer is a small info
 *   icon with its text in a popover, never in the row.
 * Invariants:
 *   - ON_IS_CONNECT: turning a row On sends one signed connect with the typed limit; turning it Off sends a disconnect. A row that is On shows its limit as text;
 *     to change it, turn the row Off and On again with a new limit.
 *   - NO_SIGNER_IS_A_STATE: a node with no signing key shows one short line ("No signing key.") and its switches are locked.
 *   - FIVE_STATES: loading (a skeleton), empty ("No nodes yet."), sparse, dense and error ("Couldn't load." and Retry). A 401, 403 or 404 renders nothing.
 *   - ROW_STAYS: a click in flight keeps the row and shows a skeleton in its switch cell; a failure is ONE short destructive line under the row's name.
 *   - TARGETS: every control is at least 24px. Tokens only. No filters and no extra controls.
 * Side-effects: IO (through the hook)
 * Links: https://node-template.cognidao.org/knowledge/frontend-development, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

"use client";

import { Info } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { Skeleton } from "../ui/skeleton.js";
import { Switch } from "../ui/switch.js";
import { hostOf, type Money } from "./format.js";
import { CONNECTIONS_UNAVAILABLE_COPY, type ConnectionsEndpoints, NO_SIGNER_COPY, useConnections } from "./use-connections.js";

export interface ConnectionsSectionProps {
  readonly endpoints: ConnectionsEndpoints;
  /** The node's credits-to-dollars conversion. */
  readonly money: Money;
  readonly className?: string;
}

export function ConnectionsSection({ endpoints, money, className }: ConnectionsSectionProps) {
  const { state, busy, failure, reload, connect, disconnect } = useConnections(endpoints);
  const [limits, setLimits] = useState<Readonly<Record<string, string>>>({});

  if (state.status === "hidden") return null;

  return (
    <section aria-labelledby="connections-heading" className={className}>
      <div className="pt-8 pb-2">
        <h2 id="connections-heading" className="font-semibold text-foreground text-lg">
          Connections
        </h2>
        <div className="mt-2 border-border border-b" />
      </div>

      {state.status === "loading" && (
        <div className="space-y-3 py-3" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </div>
      )}

      {state.status === "unavailable" && (
        <p className="flex items-center gap-3 py-3 text-destructive text-sm" role="alert">
          {CONNECTIONS_UNAVAILABLE_COPY}
          <button type="button" className="text-foreground underline" onClick={() => void reload()}>
            Retry
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
          {state.view.targets.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">No nodes yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="w-full py-1 pr-3 font-medium">Node</th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">Limit</th>
                  <th scope="col" className="w-12 py-1 text-right font-medium">On</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {state.view.targets.map((target) => {
                  const saving = busy === target.alias;
                  const on = target.status === "connected";
                  const locked = busy !== null || !state.view.signer;
                  return (
                    <tr key={target.alias} aria-busy={saving || undefined}>
                      <td className="max-w-0 py-2 pr-3 align-top">
                        <div className="flex min-w-0 items-center gap-1">
                          <span className="truncate font-medium text-foreground">{target.alias}</span>
                          {target.offer && (
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button type="button" size="sm" variant="ghost" className="h-6 w-6 shrink-0 px-0" aria-label={`Offer from ${target.alias}`}>
                                  <Info aria-hidden="true" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent align="start" className="w-64 text-sm">
                                {target.offer}
                              </PopoverContent>
                            </Popover>
                          )}
                        </div>
                        <div className="truncate text-muted-foreground text-xs">{hostOf(target.origin)}</div>
                        {failure?.rowId === target.alias && (
                          <p className="text-destructive text-xs" role="alert" title={failure.code === null ? undefined : String(failure.code)}>
                            {failure.text}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3 text-right align-top tabular-nums">
                        {on && target.cap !== null ? (
                          <span className="text-foreground">{money.format(target.cap)}</span>
                        ) : (
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0.01}
                            step={0.01}
                            placeholder="$5"
                            disabled={saving || !state.view.signer}
                            className="ml-auto h-8 w-24 text-right tabular-nums"
                            aria-label={`Limit in dollars for ${target.alias}`}
                            value={limits[target.alias] ?? ""}
                            onChange={(event) => setLimits((prev) => ({ ...prev, [target.alias]: event.target.value }))}
                          />
                        )}
                      </td>
                      <td className="h-10 py-2 text-right align-top">
                        {saving ? (
                          <>
                            <Skeleton className="ml-auto h-5 w-9 rounded-full" />
                            <span className="sr-only" role="status">
                              Saving
                            </span>
                          </>
                        ) : (
                          <Switch
                            on={on}
                            label={`${target.alias}: On`}
                            locked={locked}
                            onToggle={() =>
                              void (on ? disconnect(target.alias) : connect(target.alias, money.toCredits(Number(limits[target.alias] ?? "")) ?? 0))
                            }
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
