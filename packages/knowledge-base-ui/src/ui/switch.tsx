// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/ui/switch`
 * Purpose: The one On/Off switch of the admin tables (AI access, Connected nodes, Connections), so every "On" column looks and behaves the same.
 * Scope: Presentation only.
 * Invariants: `locked` ignores clicks while another row saves; it never dims the switch. `role="switch"` with `aria-checked` and a row-specific label.
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
