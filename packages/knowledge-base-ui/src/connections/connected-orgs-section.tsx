// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/connected-orgs-section`
 * Purpose: Helps a provider admin decide how much more each connected node may spend. The "Connected nodes" list (story.0038, connect from home). One item = name (always the node's host, never an
 *   id), a short status badge (Connected, Off, Suspended), ONE number (the allowance left, "500 cr"; tapping it shows used, cap and the node id when its `trusted_homes` entry names one) and ONE inline
 *   action: "Add credits" (a number and a button, one compact control). Suspend or Resume and the rare Reset seq (after one short dialog) live in the row's ⋯ menu.
 * Scope: Presentation over `useConnectedOrgs`. Same heading, rule and divider style as `AgentAccessSection`. Words are kept to the minimum: no subtitle, no explanations. A failed click is ONE short
 *   destructive line under that row's own controls ("Couldn't save.", "Not allowed."), the HTTP status only as its title.
 * Invariants:
 *   - FIVE_STATES: loading (a skeleton that mirrors the items), empty ("No nodes yet."), sparse, dense (a "More" button pages) and error ("Couldn't load." and Retry). A 401, 403 or 404 renders nothing.
 *   - MOBILE_FIRST: at 360px each item is stacked (name, badge and number, then full-width controls of at least 44px); from `md:` everything sits on one line. No horizontal scroll.
 *   - ROW_STAYS: a click in flight keeps the row and DISABLES its controls (other rows' clicks are ignored); when the action finishes focus returns to the row's ⋯ trigger, so a keyboard user is never dropped.
 *   - RESET_IS_A_DIALOG: Reset seq opens a Radix AlertDialog with one sentence ("Reset seq to 1?") and Cancel and Reset buttons; Cancel and Escape do nothing.
 *   - TARGETS: every control is at least 24px; the primary mobile actions are 44px. Tokens only: semantic colours, no raw palette, no inline style, no magic size.
 *   - No filters and no extra controls.
 * Side-effects: IO (through the hook)
 * Links: https://node-template.cognidao.org/knowledge/frontend-development, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

"use client";

import type { ConnectedOrgView } from "@cogni/agent-grants";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../cn.js";
import { RelativeTime } from "../relative-time.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogTitle } from "../ui/alert-dialog.js";
import { Button } from "../ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { Input } from "../ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { Skeleton } from "../ui/skeleton.js";
import { formatCredits, hostOf } from "./format.js";
import { CONNECTED_ORGS_UNAVAILABLE_COPY, type ConnectedOrgsEndpoints, useConnectedOrgs } from "./use-connected-orgs.js";

export interface ConnectedOrgsSectionProps {
  readonly endpoints: ConnectedOrgsEndpoints;
  readonly className?: string;
}

const STATUS_LABEL: Record<ConnectedOrgView["status"], string> = { connected: "Connected", suspended: "Suspended", disconnected: "Off" };

/** Full-width 44px on a phone, compact from `md:`. */
const TOUCH = "h-11 md:h-8";

/** The loading state: the same structure as an item, so the first paint does not shift. */
function ItemSkeleton() {
  return (
    <li className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-11 w-full md:h-8 md:w-64" />
    </li>
  );
}

export function ConnectedOrgsSection({ endpoints, className }: ConnectedOrgsSectionProps) {
  const { state, busy, error, reload, more, suspend, grant, resetSeq } = useConnectedOrgs(endpoints);
  const [amounts, setAmounts] = useState<Readonly<Record<string, string>>>({});
  const [resetting, setResetting] = useState<ConnectedOrgView | null>(null);
  /** Each row's ⋯ trigger: focus goes back to it when an action finishes. */
  const triggers = useRef(new Map<string, HTMLElement | null>());
  const wasBusy = useRef<string | null>(null);
  /** The row whose Reset seq dialog is open (kept after it closes, so focus can go back to its trigger). */
  const resetRow = useRef<string | null>(null);

  useEffect(() => {
    if (busy !== null) {
      wasBusy.current = busy;
      return;
    }
    if (wasBusy.current !== null) {
      triggers.current.get(wasBusy.current)?.focus();
      wasBusy.current = null;
    }
  }, [busy]);

  if (state.status === "hidden") return null;

  const grantFor = async (org: ConnectedOrgView): Promise<void> => {
    const ok = await grant(org, Number(amounts[org.orgUserId] ?? ""));
    if (ok) setAmounts((prev) => ({ ...prev, [org.orgUserId]: "" }));
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
        <ul className="divide-y divide-border" aria-busy="true" aria-label="Loading">
          <ItemSkeleton />
          <ItemSkeleton />
          <ItemSkeleton />
        </ul>
      )}

      {state.status === "unavailable" && (
        <div className="flex items-center gap-3 py-3" role="alert">
          <p className="text-destructive text-sm">{CONNECTED_ORGS_UNAVAILABLE_COPY}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      )}

      {state.status === "ready" && (
        <div className="py-2">
          {state.page.orgs.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">No nodes yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {state.page.orgs.map((org) => {
                const saving = busy === org.orgUserId;
                const title = hostOf(org.issuer);
                return (
                  <li key={org.orgUserId} aria-busy={saving || undefined} className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex min-w-0 items-center justify-between gap-3 md:justify-start">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-mono text-foreground">{title}</span>
                        <span
                          className={cn(
                            "shrink-0 rounded border px-1 font-medium text-xs",
                            org.status === "suspended" ? "border-destructive text-destructive" : "border-foreground/40 text-foreground"
                          )}
                        >
                          {STATUS_LABEL[org.status]}
                        </span>
                      </div>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button type="button" size="sm" variant="ghost" className="shrink-0 tabular-nums" aria-label={`Allowance ${formatCredits(org.allowance)} for ${title}. Show usage`}>
                            {formatCredits(org.allowance)}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-auto text-sm">
                          <dl className="space-y-1 tabular-nums">
                            <div className="flex justify-between gap-6">
                              <dt className="text-muted-foreground">Used</dt>
                              <dd className="text-foreground">{formatCredits(org.debits)}</dd>
                            </div>
                            <div className="flex justify-between gap-6">
                              <dt className="text-muted-foreground">Cap</dt>
                              <dd className="text-foreground">{formatCredits(org.cap)}</dd>
                            </div>
                            {org.lastCallAt && (
                              <div className="flex justify-between gap-6">
                                <dt className="text-muted-foreground">Last call</dt>
                                <dd className="text-foreground">
                                  <RelativeTime iso={org.lastCallAt} className="text-foreground" />
                                </dd>
                              </div>
                            )}
                            {org.nodeId && (
                              <div className="flex justify-between gap-6">
                                <dt className="text-muted-foreground">Node</dt>
                                <dd className="min-w-0 truncate font-mono text-foreground">{org.nodeId}</dd>
                              </div>
                            )}
                          </dl>
                        </PopoverContent>
                      </Popover>
                    </div>

                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="flex min-w-0 flex-1 md:flex-none">
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            step={1}
                            disabled={saving}
                            className={cn(TOUCH, "min-w-0 flex-1 rounded-r-none tabular-nums md:w-24 md:flex-none")}
                            placeholder="500"
                            aria-label={`Credits to add for ${title}`}
                            value={amounts[org.orgUserId] ?? ""}
                            onChange={(event) => setAmounts((prev) => ({ ...prev, [org.orgUserId]: event.target.value }))}
                          />
                          <Button type="button" size="sm" disabled={saving} className={cn(TOUCH, "shrink-0 rounded-l-none")} onClick={() => void grantFor(org)}>
                            Add credits
                          </Button>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              ref={(el) => {
                                triggers.current.set(org.orgUserId, el);
                              }}
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={saving}
                              className={cn(TOUCH, "w-11 shrink-0 px-0 md:w-8")}
                              aria-label={`More for ${title}`}
                            >
                              <MoreHorizontal aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => void suspend(org)}>{org.status === "suspended" ? "Resume" : "Suspend"}</DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                resetRow.current = org.orgUserId;
                                setResetting(org);
                              }}
                            >
                              Reset seq
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {saving && (
                        <span className="sr-only" role="status">
                          Saving
                        </span>
                      )}
                      {error?.rowId === org.orgUserId && (
                        <p className="text-destructive text-xs md:text-right" role="alert" title={error.code === null ? undefined : String(error.code)}>
                          {error.text}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {state.page.nextAfter && (
            <div className="mt-3 flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" className="h-11 w-full md:h-8 md:w-auto" onClick={() => void more()}>
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

      <AlertDialog open={resetting !== null} onOpenChange={(open) => !open && setResetting(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // Focus goes back to the row's ⋯ trigger (Radix would look for the menu item that is gone).
            event.preventDefault();
            if (resetRow.current) triggers.current.get(resetRow.current)?.focus();
          }}
        >
          <AlertDialogTitle>Reset seq to 1?</AlertDialogTitle>
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline" className={cn(TOUCH, "w-full md:w-auto")}>
                Cancel
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                className={cn(TOUCH, "w-full md:w-auto")}
                onClick={() => {
                  if (resetting) void resetSeq(resetting);
                }}
              >
                Reset
              </Button>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
