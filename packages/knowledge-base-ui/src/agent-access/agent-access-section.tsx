// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/agent-access-section`
 * Purpose: "AI access": one compact table where a DAO admin says yes or no to what each AI can do.
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
import { HIGHLIGHT_CLASS, useScrollToHighlight } from "./highlight.js";
import { OwnerAccessSection } from "./owner-access-section.js";
import { Switch } from "./switch.js";
import {
  type AgentAccessEndpoints,
  type OwnerAccessEndpoints,
  UNAVAILABLE_COPY,
  useAgentAccess,
} from "./use-agent-access.js";

export interface AgentAccessSectionProps {
  /** Admin endpoints (`{ roles }`) render the node-admin table; owner endpoints (`{ mine, ... }`) render the person's "Your AIs". One component, two planes. */
  readonly endpoints: AgentAccessEndpoints | OwnerAccessEndpoints;
  readonly className?: string;
  /**
   * The id from a deep link (`?request=<id>` or `?claim=<id>`). The row with that id is scrolled to and highlighted. A link to a row this session cannot see highlights nothing.
   */
  readonly highlightId?: string | undefined;
}

/** The same section on both pages. Admin passes the admin endpoints; the profile passes the owner endpoints. */
export function AgentAccessSection(props: AgentAccessSectionProps) {
  const { endpoints, ...rest } = props;
  return "mine" in endpoints ? (
    <OwnerAccessSection endpoints={endpoints} {...rest} />
  ) : (
    <AdminAccessSection endpoints={endpoints} {...rest} />
  );
}


const keyOf = (row: NodeAiPermissionView) => `${row.principalUserId}|${row.scope}`;

const BLOCKS: ReadonlyArray<{ section: AccessSection; title: string }> = [
  { section: "pending", title: "Asks waiting" },
  { section: "node", title: "This node's AI" },
  { section: "outside", title: "Outside agents" },
  // An owner turned these on for their own AI. An admin cannot approve one, only turn it Off (the kill switch).
  { section: "personal", title: "Delegated by owners" },
];

function AdminAccessSection({
  endpoints,
  className,
  highlightId,
}: AgentAccessSectionProps & { readonly endpoints: AgentAccessEndpoints }) {
  const { state, busy, error, allow, remove, dismiss, reload } = useAgentAccess(endpoints);
  const highlighted = state.status === "ready" && highlightId ? state.view.permissions.find((r) => r.requestId === highlightId) : undefined;
  useScrollToHighlight(highlighted ? `ask-${highlighted.requestId}` : null, state.status === "ready");

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
          {state.view.permissions.length === 0 ? (
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
                const rows = state.view.permissions.filter((r) => r.section === section);
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
                        <tr
                          key={key}
                          id={row.requestId ? `ask-${row.requestId}` : undefined}
                          aria-busy={saving || undefined}
                          className={row.requestId && row.requestId === highlightId ? HIGHLIGHT_CLASS : undefined}
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
                                  {row.hint ?? "No owner"}
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
                            {row.section === "pending" ? "—" : row.until ? (row.section === "personal" ? new Date(row.until).toLocaleDateString() : row.until) : "No end"}
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
                                      : allow(row.principalUserId, row.scope))
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
