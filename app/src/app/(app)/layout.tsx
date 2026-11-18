// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/layout`
 * Purpose: Sidebar navigation shell for protected application pages.
 * Scope: Server component providing the sidebar + top bar shell for all routes under (app). Does not handle authentication — proxy.ts guarantees only authenticated users reach this layout. Runs the one admin check once per layout render, only to show the Admin nav link.
 * Invariants: Auth enforced at proxy level; ONE_ADMIN_CHECK: `isNodeAdmin` is `agentAuthority.adminCheck` on the signed-in user (a UX hint; the `(admin)/` layout and API routes enforce).
 * Side-effects: IO (auth session read, bound-wallet read)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/security-auth.md, src/proxy.ts
 * @public
 */

import type { ReactNode } from "react";

import { getContainer } from "@/bootstrap/container";
import { getServerSessionUser } from "@/lib/auth/server";
import { AppLayoutShell } from "./_components/AppLayoutShell";

export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const user = await getServerSessionUser().catch(() => null);
  const isNodeAdmin = user
    ? (await getContainer()
        .agentAuthority.adminCheck(user.id)
        .catch(() => "unavailable" as const)) === "allow"
    : false;
  return <AppLayoutShell isNodeAdmin={isNodeAdmin}>{children}</AppLayoutShell>;
}
