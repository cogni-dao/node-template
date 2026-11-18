// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/layout`
 * Purpose: Server-side gate + sidebar shell for DAO admin pages.
 * Scope: Server component. Runs the one node-admin check (`agentAuthority.adminCheck`, the same one the admin routes and /api/v1/agent/me use) on the signed-in user, and redirects non-admins to `/dashboard`. Hands the approved request to the same client sidebar shell as `(app)/`. Does not handle data fetching.
 * Invariants: ONE_ADMIN_CHECK — a page renders exactly when its API routes would admit the same user; admin pages are unreachable for non-admins. Authentication is enforced by `proxy.ts` (login redirect); this layout enforces the admin-role check on top.
 * Side-effects: IO (auth session read, repo-spec read on first call), structured gate log (route="admin.gate"), redirect
 * Links: src/app/api/v1/attribution/_lib/approver-guard.ts, src/shared/config/repoSpec.server.ts, .cogni/repo-spec.yaml
 * @public
 */

import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getServerSessionUser } from "@/lib/auth/server";
import { getContainer } from "@/bootstrap/container";
import { makeLogger } from "@/shared/observability";

import { AdminShell } from "./AdminShell";

const log = makeLogger({ route: "admin.gate" });

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const user = await getServerSessionUser();
  const allowed = user
    ? await getContainer().agentAuthority.adminCheck(user.id).catch(() => "unavailable" as const)
    : "denied";

  if (allowed !== "allow") {
    log.warn({ userId: user?.id ?? null, allowed: false }, "admin gate denied");
    redirect("/dashboard");
  }

  log.info({ userId: user?.id ?? null, allowed: true }, "admin gate allowed");
  return <AdminShell>{children}</AdminShell>;
}
