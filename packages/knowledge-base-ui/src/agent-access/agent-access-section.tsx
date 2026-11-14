// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/agent-access-section`
 * Purpose: "AI access": one compact table where the approver says yes or no to what each AI can do.
 *   Columns: Who · Can do · Until · On. One row = one grant row, in three blocks: asks waiting, this node's AI, outside agents.
 *   Two mounts share it (TWO_STARTS, ONE_TABLE): the Admin page (`mode="admin"`, a node-admin, node permissions) and the profile (`mode="account"`,
 *   any signed-in person, the AIs that may act on their own account, with an Until control of 1, 7 or 30 days).
 * Scope: Presentation over `useAgentAccess`. In admin mode it renders nothing for a non-admin.
 * Invariants:
 *   - ONE_CONTROL_ONE_DECISION: the switch is the whole decision, both directions. No "are you sure" step. A pending ask also
 *     has an x that dismisses it.
 *   - NAMES_ARE_IDENTIFIERS: "Who" is never a vanity label: this node's AI by its slug (mono), an outside agent by its registered
 *     name with the outside badge and binding. All the human words are in "Can do".
 *   - DECLARED_ONCE_SHOWN_EVERYWHERE: "Can do" shows the name and the one-line description the server sends from the
 *     declaration. This file holds no copy table.
 *   - NON_ADMIN_SEES_NOTHING (admin mode): renders `null` while loading and for every state except a confirmed admin view (`ready`)
 *     or a confirmed 503 (`unavailable`). No heading or skeleton shows to a non-admin.
 *   - PROFILE_NEVER_SHOWS_NODE_ROWS / ADMIN_NEVER_SHOWS_ACCOUNT_ROWS: the section also drops any row of the other resource, so a server that sent one would
 *     still not put it on the wrong page.
 *   - LINK_HIGHLIGHT: a row an AI's one-time link opened is scrolled to and highlighted; a link that opens nothing shows one neutral line.
 *   - A click in flight replaces that row's switch with a Skeleton. A switch is never shown dimmed.
 *   - HUMAN_SURFACE_TOKENLESS: the text holds no token, id, key, scope string or API path.
 *   - PLAIN_NAMES: a grant gives a permission. No other noun, no risk labels.
 * Side-effects: IO (through the hook)
 * Links: https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

"use client";

import type { AccessSection, NodeAiPermissionView } from "@cogni/agent-grants";
import { useState } from "react";

import { cn } from "../cn.js";
import { Skeleton } from "../ui/skeleton.js";
import { HIGHLIGHT_CLASS, HIGHLIGHT_DOM_ID, useScrollToHighlight } from "./highlight.js";
import {
  type AgentAccessEndpoints,
  type AgentAccessMode,
  LINK_INVALID_COPY,
  rowKey,
  UNAVAILABLE_COPY,
  useAgentAccess,
} from "./use-agent-access.js";

export interface AgentAccessSectionProps {
  readonly endpoints: AgentAccessEndpoints;
  /** `admin` (default): a node-admin's node permissions. `account`: a person's own account, shown to every signed-in person. */
  readonly mode?: AgentAccessMode;
  /** The one-time link token the page read from the URL fragment (`useApprovalFragment`), or null. */
  readonly token?: string | null;
  readonly className?: string;
}

/** The Until choices on an account grant, in days. The server accepts exactly these; 7 is the default. */
const UNTIL_DAYS = [1, 7, 30] as const;
const DEFAULT_DAYS = 7;
const UNTIL_LABEL: Record<number, string> = { 1: "1 day", 7: "7 days", 30: "30 days" };

const BLOCKS: ReadonlyArray<{ section: AccessSection; title: string }> = [
  { section: "pending", title: "Asks waiting" },
  { section: "node", title: "This node's AI" },
  { section: "outside", title: "Outside agents" },
];

/** A date for the end of an account grant: day and month, from the ISO the server sent. */
function untilDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function AgentAccessSection({ endpoints, mode = "admin", token = null, className }: AgentAccessSectionProps) {
  const { state, busy, error, highlight, linkInvalid, allow, remove, dismiss, reload } = useAgentAccess(endpoints, { mode, token });
  const [days, setDays] = useState<Record<string, number>>({});
  const ready = state.status === "ready";
  const permissions: readonly NodeAiPermissionView[] = ready
    ? state.view.permissions.filter((r) => (mode === "account" ? r.resource === "account" : r.resource !== "account"))
    : [];
  useScrollToHighlight(ready && highlight !== null && permissions.some((r) => rowKey(r) === highlight));

  if (state.status === "loading" && mode === "account") {
    // A person always has a profile table: show its shape while it loads (admin mode shows nothing until the server confirms an admin).
    return (
      <section aria-label="AI access" className={className}>
        <div className="pt-8 pb-2">
          <Skeleton className="h-6 w-32" />
          <div className="mt-2 border-border border-b" />
        </div>
        <Skeleton className="mt-3 h-10 w-full" />
        <Skeleton className="mt-2 h-10 w-full" />
      </section>
    );
  }

  // No flash: nothing renders until the server confirms an admin view or a 503.
  if (state.status === "hidden" || state.status === "loading") return null;

  return (
    <section aria-labelledby="node-ai-heading" className={className}>
      <div className="pt-8 pb-2">
        <h2 id="node-ai-heading" className="font-semibold text-foreground text-lg">
          AI access
        </h2>
        <div className="mt-2 border-border border-b" />
      </div>

      {linkInvalid && (
        <p className="pt-3 text-muted-foreground text-sm" role="status">
          {LINK_INVALID_COPY}
        </p>
      )}

      {state.status === "unavailable" && (
        <p className="flex items-center gap-3 py-3 text-destructive text-sm" role="alert">
          {UNAVAILABLE_COPY}
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
          {state.view.more > 0 && (
            <p className="pb-2 text-muted-foreground text-xs" role="status">
              {state.view.more} more outside {state.view.more === 1 ? "row is" : "rows are"} not shown. Clear some to see them.
            </p>
          )}
          {permissions.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">Nothing to manage.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">Who</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Can do</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Until</th>
                  <th scope="col" className="w-20 py-1 text-right font-medium">On</th>
                </tr>
              </thead>
              {BLOCKS.map(({ section, title }) => {
                const rows = permissions.filter((r) => r.section === section);
                if (rows.length === 0) return null;
                return (
                  <tbody key={section} className="divide-y divide-border">
                    <tr>
                      <th
                        scope="rowgroup"
                        colSpan={4}
                        className="pt-4 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide"
                      >
                        {title}
                      </th>
                    </tr>
                    {rows.map((row) => {
                      const key = rowKey(row);
                      const saving = busy === key;
                      const highlighted = highlight === key;
                      const picked = days[key] ?? DEFAULT_DAYS;
                      return (
                        <tr
                          key={key}
                          id={highlighted ? HIGHLIGHT_DOM_ID : undefined}
                          aria-busy={saving || undefined}
                          className={highlighted ? HIGHLIGHT_CLASS : undefined}
                        >
                          <td className="py-2 pr-3 align-top text-foreground">
                            {row.outside ? (
                              // An outside agent chose its own name. The badge comes first, the name is quoted, and the proven
                              // binding (when there is one) sits beside it, so an outside "General assistant" is never
                              // mistaken for this node's AI.
                              <>
                                <span className="mr-2 rounded border border-foreground/40 px-1 font-medium text-xs">
                                  outside
                                </span>
                                <span>&ldquo;{row.who}&rdquo;</span>
                                <div className="text-muted-foreground text-xs">
                                  {row.hint ?? "No linked account"}
                                </div>
                              </>
                            ) : (
                              // NAMES_ARE_IDENTIFIERS: this node's AI is shown by its slug, in mono. All the human words are in "Can do".
                              <span className="font-mono">{row.who}</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 align-top">
                            <div className="text-foreground">{row.label}</div>
                            <div className="text-muted-foreground text-xs">{row.description}</div>
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 align-top text-muted-foreground">
                            {mode === "account" && !row.on ? (
                              <select
                                aria-label={`Until: ${row.who}: ${row.label}`}
                                value={picked}
                                onChange={(e) => setDays((d) => ({ ...d, [key]: Number(e.target.value) }))}
                                className="h-7 rounded-md border border-input bg-background px-1 text-foreground text-sm"
                              >
                                {UNTIL_DAYS.map((n) => (
                                  <option key={n} value={n}>
                                    {UNTIL_LABEL[n]}
                                  </option>
                                ))}
                              </select>
                            ) : mode === "account" ? (
                              row.until ? `Until ${untilDate(row.until)}` : "No end"
                            ) : row.section === "pending" ? (
                              "—"
                            ) : (
                              (row.until ?? "No end")
                            )}
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
                                  onToggle={() =>
                                    void (row.on
                                      ? remove(row.principalUserId, row.scope)
                                      : allow(row.principalUserId, row.scope, mode === "account" ? { days: picked } : undefined))
                                  }
                                />
                                {row.section === "pending" && (
                                  <button
                                    type="button"
                                    aria-label={`Dismiss the ask: ${row.who}: ${row.label}`}
                                    aria-disabled={busy !== null || undefined}
                                    className="px-1 text-muted-foreground hover:text-foreground"
                                    onClick={() => {
                                      if (busy === null) void dismiss(row.principalUserId, row.scope);
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
                );
              })}
            </table>
          )}
        </div>
      )}
    </section>
  );
}

/** A small switch. `locked` ignores clicks while another row saves; it never dims the switch. */
function Switch(props: { on: boolean; label: string; locked: boolean; onToggle: () => void }) {
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
