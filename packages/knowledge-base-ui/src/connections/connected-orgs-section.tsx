// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/connected-orgs-section`
 * Purpose: Helps a provider admin see which other nodes are customers, what they used, and keep each one On or Off. The "Connected nodes" table (story.0038,
 *   connect from home). Columns Node · Used · Left · On, the same table, heading and switch as the AI access table.
 * Scope: Presentation over `useConnectedOrgs`. Money is dollars through the injected `Money`. Words are kept to the minimum: no subtitle, no explanations.
 * Invariants:
 *   - NAME_FIRST: a node is its name from the provider's own `trusted_homes` entry, with its host as a small second line; the host alone only when no name is configured.
 *   - ONE_SWITCH: On is the provider's own switch (Off = suspended; the customer cannot turn it back On). A customer that disconnected shows a "Disconnected" badge.
 *   - FREE_CREDITS_ARE_SECONDARY: the only money action is a small "+" beside Left that opens "Free credits" (a dollar input and Add). It is a prototype comp grant,
 *     never a payment; the customer funding its own account is not built.
 *   - FIVE_STATES: loading (a skeleton), empty ("No nodes yet."), sparse, dense (a "More" button pages) and error ("Couldn't load." and Retry). A 401, 403 or 404 renders nothing.
 *   - ROW_STAYS: a click in flight keeps the row and shows a skeleton in its switch cell; other rows' clicks are ignored.
 *   - TARGETS: every control is at least 24px. Tokens only. No filters and no extra controls.
 * Side-effects: IO (through the hook)
 * Links: https://node-template.cognidao.org/knowledge/frontend-development, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

"use client";

import type { ConnectedOrgView } from "@cogni/agent-grants";
import { Plus } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { Skeleton } from "../ui/skeleton.js";
import { Switch } from "../ui/switch.js";
import { hostOf, type Money } from "./format.js";
import { CONNECTED_ORGS_BAD_AMOUNT_COPY, CONNECTED_ORGS_UNAVAILABLE_COPY, type ConnectedOrgsEndpoints, useConnectedOrgs } from "./use-connected-orgs.js";

export interface ConnectedOrgsSectionProps {
  readonly endpoints: ConnectedOrgsEndpoints;
  /** The node's credits-to-dollars conversion. */
  readonly money: Money;
  readonly className?: string;
}

const nameOf = (org: ConnectedOrgView): string => org.name ?? hostOf(org.issuer);

export function ConnectedOrgsSection({ endpoints, money, className }: ConnectedOrgsSectionProps) {
  const { state, busy, error, reload, more, suspend, grant } = useConnectedOrgs(endpoints);
  const [amounts, setAmounts] = useState<Readonly<Record<string, string>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [badAmount, setBadAmount] = useState<string | null>(null);

  if (state.status === "hidden") return null;

  const add = async (org: ConnectedOrgView): Promise<void> => {
    const credits = money.toCredits(Number(amounts[org.orgUserId] ?? ""));
    if (credits === null) {
      setBadAmount(org.orgUserId);
      return;
    }
    setBadAmount(null);
    if (await grant(org, credits)) {
      setAmounts((prev) => ({ ...prev, [org.orgUserId]: "" }));
      setOpen(null);
    }
  };

  return (
    <section aria-labelledby="connected-orgs-heading" className={className}>
      <div className="pt-8 pb-2">
        <h2 id="connected-orgs-heading" className="font-semibold text-foreground text-lg">
          Connected nodes
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
          {CONNECTED_ORGS_UNAVAILABLE_COPY}
          <button type="button" className="text-foreground underline" onClick={() => void reload()}>
            Retry
          </button>
        </p>
      )}

      {state.status === "ready" && (
        <div className="py-2">
          {state.page.orgs.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">No nodes yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">Node</th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">Used</th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">Left</th>
                  <th scope="col" className="w-12 py-1 text-right font-medium">On</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {state.page.orgs.map((org) => {
                  const name = nameOf(org);
                  const saving = busy === org.orgUserId;
                  return (
                    <tr key={org.orgUserId} aria-busy={saving || undefined}>
                      <td className="max-w-0 py-2 pr-3 align-top">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-foreground">{name}</span>
                          {org.status === "disconnected" && <Badge>Disconnected</Badge>}
                        </div>
                        {org.name && <div className="truncate text-muted-foreground text-xs">{hostOf(org.issuer)}</div>}
                        {error?.rowId === org.orgUserId && (
                          <p className="text-destructive text-xs" role="alert" title={error.code === null ? undefined : String(error.code)}>
                            {error.text}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3 text-right align-top tabular-nums">
                        <div className="text-foreground">{money.format(org.debits)}</div>
                        <div className="text-muted-foreground text-xs">of {money.format(org.cap)}</div>
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3 text-right align-top tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          <span className="text-foreground">{money.format(Math.max(0, org.allowance))}</span>
                          <Popover
                            open={open === org.orgUserId}
                            onOpenChange={(next) => {
                              setOpen(next ? org.orgUserId : null);
                              setBadAmount(null);
                            }}
                          >
                            <PopoverTrigger asChild>
                              <Button type="button" size="sm" variant="ghost" className="h-6 w-6 px-0" disabled={busy !== null} aria-label={`Free credits for ${name}`}>
                                <Plus aria-hidden="true" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent align="end" className="w-60 space-y-2 text-sm">
                              <form
                                className="space-y-2"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  void add(org);
                                }}
                              >
                                <label htmlFor={`free-${org.orgUserId}`} className="font-medium text-foreground">
                                  Free credits
                                </label>
                                <div className="flex gap-2">
                                  <Input
                                    id={`free-${org.orgUserId}`}
                                    type="number"
                                    inputMode="decimal"
                                    min={0.01}
                                    step={0.01}
                                    placeholder="$5"
                                    disabled={saving}
                                    className="h-8 tabular-nums"
                                    value={amounts[org.orgUserId] ?? ""}
                                    onChange={(event) => setAmounts((prev) => ({ ...prev, [org.orgUserId]: event.target.value }))}
                                  />
                                  <Button type="submit" size="sm" className="h-8" disabled={saving}>
                                    Add
                                  </Button>
                                </div>
                                {badAmount === org.orgUserId && (
                                  <p className="text-destructive text-xs" role="alert">
                                    {CONNECTED_ORGS_BAD_AMOUNT_COPY}
                                  </p>
                                )}
                              </form>
                            </PopoverContent>
                          </Popover>
                        </span>
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
                          <Switch on={org.status !== "suspended"} label={`${name}: On`} locked={busy !== null} onToggle={() => void suspend(org)} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {state.page.nextAfter && (
            <div className="mt-3 flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={() => void more()}>
                More
              </Button>
              {error?.rowId === "" && (
                <p className="text-destructive text-xs" role="alert">
                  {error.text}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
