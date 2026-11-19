// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/connections-section`
 * Purpose: Helps a customer admin decide which other node this node may spend on, and how much. The "Connections" list (story.0038, connect from home). One item = name (the target's alias), a short
 *   status badge (Connected or Off), ONE number (the stored cap, "500 cr", only when connected) and ONE inline action: "Connect" (a cap number and a button, one compact control). Disconnect lives in
 *   the row's ⋯ menu. The provider's offer is a small info icon with the text in a popover, never in the row.
 * Scope: Presentation over `useConnections`. Same heading, rule and divider style as `AgentAccessSection`. Words are kept to the minimum: no subtitle, no origin line, no explanations.
 * Invariants:
 *   - FIVE_STATES: loading (a skeleton that mirrors the items), empty ("No nodes yet."), sparse, dense and error ("Couldn't load." and Retry). A 401, 403 or 404 renders nothing.
 *   - NO_SIGNER_IS_A_STATE: a node with no signing key shows one short line ("No signing key.") and offers no controls; names, status and the offer icon still show.
 *   - MOBILE_FIRST: at 360px each item is stacked (name, badge and number, then a full-width input and 44px button); controls are never dropped at any width. No horizontal scroll.
 *   - ONE_CLICK_ONE_ACTION: a click in flight replaces that item's controls with a Skeleton; every other click is ignored meanwhile (never dimmed).
 *   - TARGETS: every control is at least 24px; the primary mobile actions are 44px. Tokens only: semantic colours, no raw palette, no inline style, no magic size.
 *   - No filters and no extra controls.
 * Side-effects: IO (through the hook)
 * Links: https://node-template.cognidao.org/knowledge/frontend-development, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

"use client";

import { Info, MoreHorizontal } from "lucide-react";
import { useState } from "react";

import { cn } from "../cn.js";
import { Button } from "../ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { Input } from "../ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { Skeleton } from "../ui/skeleton.js";
import { formatCredits } from "./format.js";
import { CONNECTIONS_UNAVAILABLE_COPY, type ConnectionsEndpoints, NO_SIGNER_COPY, useConnections } from "./use-connections.js";

export interface ConnectionsSectionProps {
  readonly endpoints: ConnectionsEndpoints;
  readonly className?: string;
}

/** Full-width 44px on a phone, compact from `md:`. */
const TOUCH = "h-11 md:h-8";

/** The loading state: the same structure as an item, so the first paint does not shift. */
function ItemSkeleton() {
  return (
    <li className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-11 w-full md:h-8 md:w-64" />
    </li>
  );
}

export function ConnectionsSection({ endpoints, className }: ConnectionsSectionProps) {
  const { state, busy, answer, reload, connect, disconnect } = useConnections(endpoints);
  const [caps, setCaps] = useState<Readonly<Record<string, string>>>({});

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
        <ul className="divide-y divide-border" aria-busy="true" aria-label="Loading">
          <ItemSkeleton />
          <ItemSkeleton />
        </ul>
      )}

      {state.status === "unavailable" && (
        <div className="flex items-center gap-3 py-3" role="alert">
          <p className="text-destructive text-sm">{CONNECTIONS_UNAVAILABLE_COPY}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
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
            <p className="py-2 text-muted-foreground text-sm">No nodes yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {state.view.targets.map((target) => {
                const saving = busy === target.alias;
                const connected = target.status === "connected";
                return (
                  <li key={target.alias} aria-busy={saving || undefined} className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex min-w-0 items-center justify-between gap-3 md:justify-start">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-mono text-foreground">{target.alias}</span>
                        <span className="shrink-0 rounded border border-foreground/40 px-1 font-medium text-foreground text-xs">{connected ? "Connected" : "Off"}</span>
                        {target.offer && (
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button type="button" size="sm" variant="ghost" className="w-8 shrink-0 px-0" aria-label={`Offer from ${target.alias}`}>
                                <Info aria-hidden="true" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent align="start" className="w-64 text-sm">
                              {target.offer}
                            </PopoverContent>
                          </Popover>
                        )}
                      </div>
                      {connected && target.cap !== null && <span className="shrink-0 text-foreground text-sm tabular-nums">{formatCredits(target.cap)}</span>}
                    </div>

                    {state.view.signer &&
                      (saving ? (
                        <>
                          <Skeleton className={cn(TOUCH, "w-full md:w-64")} />
                          <span className="sr-only" role="status">Saving</span>
                        </>
                      ) : (
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="flex min-w-0 flex-1 md:flex-none">
                            <Input
                              type="number"
                              inputMode="numeric"
                              min={1}
                              step={1}
                              className={cn(TOUCH, "min-w-0 flex-1 rounded-r-none tabular-nums md:w-24 md:flex-none")}
                              placeholder="500"
                              aria-label={`Cap for ${target.alias}`}
                              value={caps[target.alias] ?? ""}
                              onChange={(event) => setCaps((prev) => ({ ...prev, [target.alias]: event.target.value }))}
                            />
                            <Button type="button" size="sm" className={cn(TOUCH, "shrink-0 rounded-l-none")} onClick={() => void connect(target.alias, Number(caps[target.alias] ?? ""))}>
                              Connect
                            </Button>
                          </div>
                          {connected && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" size="sm" variant="ghost" className={cn(TOUCH, "w-11 shrink-0 px-0 md:w-8")} aria-label={`More for ${target.alias}`}>
                                  <MoreHorizontal aria-hidden="true" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => void disconnect(target.alias)}>Disconnect</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      ))}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
