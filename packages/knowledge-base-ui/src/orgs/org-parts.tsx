// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs/org-parts`
 * Purpose: The few pieces the three org sections share: a section heading, a badge, a row menu and the error line.
 * Scope: Presentation only. Theme tokens only (`border-primary`, `text-muted-foreground`, ...); no raw colours.
 * Invariants:
 *   - WORD_PLUS_COLOUR: a badge always carries its word; colour only repeats it.
 *   - MENU_IS_THE_REST: a row shows its name and badge; what a row can do sits behind one menu button at least 36px square.
 * Side-effects: none
 * @internal
 */

"use client";

import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../cn.js";
import { Button } from "../ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import type { OrgRole } from "./org-client.js";

export function OrgHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="pt-8 pb-2">
      <h2 id={id} className="font-semibold text-foreground text-lg">
        {children}
      </h2>
      <div className="mt-2 border-border border-b" />
    </div>
  );
}

const PILL_TONES = {
  owner: "border-primary text-primary",
  admin: "border-border text-muted-foreground",
  ok: "border-success text-success",
  bad: "border-destructive text-destructive",
} as const;

export function Pill({ tone, children }: { tone: keyof typeof PILL_TONES; children: ReactNode }) {
  return <span className={cn("inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-medium text-xs", PILL_TONES[tone])}>{children}</span>;
}

export function RolePill({ role }: { role: OrgRole }) {
  return <Pill tone={role}>{role === "owner" ? "Owner" : "Admin"}</Pill>;
}

export interface RowMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
}

export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className="shrink-0">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem key={item.label} onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The "Try again" after a failed load: at least 32px tall, so it is a real tap target. */
export function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex min-h-8 items-center px-2 text-foreground underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onClick}
    >
      Try again
    </button>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="pb-2 text-destructive text-sm" role="alert">
      {message}
    </p>
  );
}

/** A native select on theme tokens, for the owner/admin choice. */
export function RoleSelect({ value, onChange, roles, label }: { value: OrgRole; onChange: (role: OrgRole) => void; roles: readonly OrgRole[]; label: string }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as OrgRole)}
      className="h-9 shrink-0 rounded-md border border-input bg-background px-2 text-foreground text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {roles.map((r) => (
        <option key={r} value={r}>
          {r === "owner" ? "Owner" : "Admin"}
        </option>
      ))}
    </select>
  );
}
