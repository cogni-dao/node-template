// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/_components/AppLayoutShell`
 * Purpose: Client sidebar + top bar shell for protected application pages.
 * Scope: Renders the shell; `isNodeAdmin` is decided by the server layout and only drives the Admin nav hint.
 * Side-effects: none
 * @internal
 */

"use client";

import type { ReactNode } from "react";

import { AppShell } from "@/features/layout/components/AppShell";
import { EntityPeekProvider } from "./EntityPeek";

export function AppLayoutShell({
  children,
  isNodeAdmin,
}: {
  children: ReactNode;
  isNodeAdmin: boolean;
}): ReactNode {
  return (
    <AppShell isNodeAdmin={isNodeAdmin}>
      <EntityPeekProvider>{children}</EntityPeekProvider>
    </AppShell>
  );
}
