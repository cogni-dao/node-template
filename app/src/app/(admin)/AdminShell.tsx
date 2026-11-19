// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/AdminShell`
 * Purpose: Client sidebar shell for admin pages — mirrors `(app)/layout.tsx` so admin/app/non-admin nav stays visually coherent.
 * Scope: Pure UI shell. Auth + role enforcement live in the server `(admin)/layout.tsx` that wraps this component.
 * Invariants: Renders children unconditionally; never gates access. BACK_TO_ADMIN: every page below `/admin` gets one "Admin" back link above its content, so a
 *   subpage is never a dead end.
 * Side-effects: none
 * Links: src/app/(admin)/layout.tsx, src/features/layout/components/AppSidebar.tsx
 * @public
 */

"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "@/components";
import { AppSidebar, AppTopBar } from "@/features/layout";

export function AdminShell({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const subpage = pathname !== null && pathname.startsWith("/admin/");
  return (
    <SidebarProvider>
      <AppSidebar isNodeAdmin />
      <SidebarInset>
        <AppTopBar />
        <div className="flex flex-1 flex-col overflow-auto">
          {subpage && (
            <Link
              href="/admin"
              className="inline-flex min-h-6 items-center gap-1 self-start px-4 pt-4 text-muted-foreground text-sm hover:text-foreground md:px-6"
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Admin
            </Link>
          )}
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
