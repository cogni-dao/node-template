// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/switch`
 * Purpose: The one small switch both AI-access tables use (the admin table and the owner's "Your AIs").
 * Scope: Presentation only. `locked` ignores clicks while another row saves; it never dims the switch.
 * Side-effects: none
 * @internal
 */

"use client";

import { cn } from "../cn.js";

export function Switch(props: { on: boolean; label: string; locked: boolean; onToggle: () => void }) {
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
