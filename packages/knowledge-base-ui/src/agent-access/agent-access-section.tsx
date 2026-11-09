// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/agent-access-section`
 * Purpose: "This node's AI": one compact table where a DAO admin allows or removes each permission of each node AI.
 * Scope: Presentation over `useAgentAccess`. Renders nothing for a non-admin. One row per (AI, permission): AI, permission,
 *   a small switch. Allow asks once, inline in the row; Remove never asks.
 * Invariants:
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

import type { NodeAiPermissionView } from "@cogni/agent-grants";
import { useState } from "react";

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

const keyOf = (row: NodeAiPermissionView) => `${row.principal}|${row.scope}`;

export function AgentAccessSection({ endpoints, className }: AgentAccessSectionProps) {
  const { state, busy, error, allow, remove, reload } = useAgentAccess(endpoints);
  const [confirming, setConfirming] = useState<string | null>(null);

  // No flash: nothing renders until the server confirms an admin view or a 503.
  if (state.status === "hidden" || state.status === "loading") return null;

  return (
    <section aria-labelledby="node-ai-heading" className={className}>
      <div className="pt-8 pb-2">
        <h2 id="node-ai-heading" className="font-semibold text-foreground text-lg">
          This node&apos;s AI
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
          {state.view.permissions.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">No permissions to manage.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">AI</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Permission</th>
                  <th scope="col" className="w-24 py-1 text-right font-medium">Allowed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {state.view.permissions.map((row) => {
                  const key = keyOf(row);
                  return (
                    <tr key={key} aria-busy={busy === key || undefined}>
                      <td className="py-2 pr-3 text-foreground">{row.ai}</td>
                      <td className="py-2 pr-3 text-foreground">{row.permission}</td>
                      <td className="h-10 py-2 text-right">
                        {busy === key ? (
                          <>
                            <Skeleton className="ml-auto h-5 w-9 rounded-full" />
                            <span className="sr-only" role="status">Saving</span>
                          </>
                        ) : confirming === key ? (
                          <span className="inline-flex items-center gap-2 text-xs">
                            <span className="text-muted-foreground">Allow?</span>
                            <button
                              type="button"
                              className="font-medium text-foreground underline"
                              aria-label={`Yes, allow ${row.ai}: ${row.permission}`}
                              onClick={() => {
                                setConfirming(null);
                                void allow(row.principal, row.scope);
                              }}
                            >
                              Yes
                            </button>
                            <button
                              type="button"
                              className="text-muted-foreground underline"
                              aria-label={`No, do not allow ${row.ai}: ${row.permission}`}
                              onClick={() => setConfirming(null)}
                            >
                              No
                            </button>
                          </span>
                        ) : (
                          <Switch
                            on={row.allowed}
                            label={`${row.ai}: ${row.permission}`}
                            locked={busy !== null}
                            onToggle={() =>
                              row.allowed ? void remove(row.principal, row.scope) : setConfirming(key)
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
