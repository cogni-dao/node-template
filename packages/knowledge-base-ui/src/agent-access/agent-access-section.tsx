// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/agent-access-section`
 * Purpose: Helps a human decide which permissions each AI may use.
 *   Columns: Who · Can do · Until · On. One row = one grant row, in three blocks: asks waiting, this node's AI, outside agents.
 * Scope: Presentation over `useAgentAccess`. Renders nothing for a non-admin.
 * Invariants:
 *   - ONE_CONTROL_ONE_DECISION: the switch is the whole decision, both directions. No "are you sure" step. A pending ask also
 *     has an x that dismisses it.
 *   - NAMES_ARE_IDENTIFIERS: "Who" is never a vanity label: this node's AI by its slug (mono), an outside agent by its registered
 *     name with the outside badge and binding. All the human words are in "Can do".
 *   - DECLARED_ONCE_SHOWN_EVERYWHERE: "Can do" shows the name and the one-line description the server sends from the
 *     declaration. This file holds no copy table.
 *   - NON_ADMIN_SEES_NOTHING: renders `null` while loading and for every state except a confirmed admin view (`ready`)
 *     or a confirmed 503 (`unavailable`). No heading or skeleton shows to a non-admin.
 *   - A click in flight replaces that row's switch with a Skeleton. A switch is never shown dimmed.
 *   - HUMAN_SURFACE_TOKENLESS: the text holds no token, id, key, scope string or API path.
 *   - PLAIN_NAMES: a grant gives a permission. No other noun, no risk labels.
 * Side-effects: IO (through the hook)
 * Links: https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

"use client";

import type { AccessSection, NodeAiPermissionView } from "@cogni/agent-grants";

import { cn } from "../cn.js";
import { Skeleton } from "../ui/skeleton.js";
import {
  type AgentAccessEndpoints,
  UNAVAILABLE_COPY,
  useAgentAccess,
} from "./use-agent-access.js";

export interface AgentAccessSectionProps {
  readonly endpoints: AgentAccessEndpoints;
  readonly className?: string;
}

const keyOf = (row: NodeAiPermissionView) =>
  `${row.principalUserId}|${row.scope}`;

const BLOCKS: ReadonlyArray<{ section: AccessSection; title: string }> = [
  { section: "pending", title: "Asks waiting" },
  { section: "node", title: "This node's AI" },
  { section: "outside", title: "Outside agents" },
];

export function AgentAccessSection({
  endpoints,
  className,
}: AgentAccessSectionProps) {
  const {
    state,
    busy,
    error,
    allow,
    remove,
    dismiss,
    reload,
    loadMore,
    loadingMore,
  } = useAgentAccess(endpoints);

  // No flash: nothing renders until the server confirms an admin view or a 503.
  if (state.status === "hidden" || state.status === "loading") return null;

  return (
    <section aria-labelledby="node-ai-heading" className={className}>
      <div className="pt-8 pb-2">
        <h2
          id="node-ai-heading"
          className="font-semibold text-foreground text-lg"
        >
          AI access
        </h2>
        <div className="mt-2 border-border border-b" />
      </div>

      {state.status === "unavailable" && (
        <p
          className="flex items-center gap-3 py-3 text-destructive text-sm"
          role="alert"
        >
          {UNAVAILABLE_COPY}
          <button
            type="button"
            className="text-foreground underline"
            onClick={() => void reload()}
          >
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
          {!state.view.nextCursor && state.view.more > 0 && (
            <p>{state.view.more} more outside rows are not shown</p>
          )}
          {state.view.nextCursor && (
            <button
              type="button"
              disabled={loadingMore || busy !== null}
              className="min-h-6 text-foreground underline focus-visible:outline focus-visible:outline-ring disabled:opacity-50"
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
          {state.view.permissions.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">
              Nothing to manage.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Who
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Can do
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Until
                  </th>
                  <th scope="col" className="w-20 py-1 text-right font-medium">
                    On
                  </th>
                </tr>
              </thead>
              {BLOCKS.map(({ section, title }) => {
                const rows = state.view.permissions.filter(
                  (r) => r.section === section
                );
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
                      const key = keyOf(row);
                      const saving = busy === key;
                      return (
                        <tr key={key} aria-busy={saving || undefined}>
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
                            <div className="text-muted-foreground text-xs">
                              {row.description}
                            </div>
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 align-top text-muted-foreground">
                            {row.section === "pending"
                              ? "—"
                              : (row.until ?? "No end")}
                          </td>
                          <td className="h-10 py-2 text-right align-top">
                            {saving ? (
                              <>
                                <Skeleton className="ml-auto h-5 w-9 rounded-full" />
                                <output className="sr-only">Saving</output>
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
                                      : allow(row.principalUserId, row.scope))
                                  }
                                />
                                {row.section === "pending" && (
                                  <button
                                    type="button"
                                    aria-label={`Dismiss the ask: ${row.who}: ${row.label}`}
                                    aria-disabled={busy !== null || undefined}
                                    className="inline-flex min-h-6 min-w-6 items-center justify-center px-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
                                    onClick={() => {
                                      if (busy === null)
                                        void dismiss(
                                          row.principalUserId,
                                          row.scope
                                        );
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
function Switch(props: {
  on: boolean;
  label: string;
  locked: boolean;
  onToggle: () => void;
}) {
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
        "relative inline-flex min-h-6 min-w-6 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
