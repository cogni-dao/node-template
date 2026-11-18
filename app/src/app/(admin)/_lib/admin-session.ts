// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/_lib/admin-session`
 * Purpose: The ONLY mint of an `AdminSession` (an admin decision). An admin route calls it first and passes it to `NodeAdminPort`.
 * Scope: Resolves the caller (a same-origin browser session or a bearer, through the one request resolver), then runs the one
 *   node-admin check on the caller's wallet. Decides nothing else.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / ONE_MINT: no other file casts to `AdminSession` (import-lock test).
 *   - ONE_ADMIN_CHECK (AUTHORITY_IS_NOT_KIND): a session and a bearer reach the same `NodeAdminAuthority`. A session is checked on
 *     its signed-in wallet; a bearer on the wallets bound to its own user (`agentAuthority.adminCheck`). A session write keeps
 *     the resolver's same-origin check.
 *   - FAIL_CLOSED_WITH_DISTINCTION: no session 401; not an admin 403 `authz_denied`; admin check down 503 `authz_unavailable`.
 *   - One `admin.action` log per minted decision: action name, admin user id and `via`, no credential.
 * Side-effects: IO (session read, repo-spec admin read, log)
 * Links: src/ports/node-admin.port.ts, src/bootstrap/node-admin-gate.ts, tests/unit/app/admin-acts-in-admin.test.ts
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import type { AdminSession } from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";

export type AdminSessionResult =
  | { readonly ok: true; readonly session: AdminSession }
  | { readonly ok: false; readonly response: NextResponse };

const refuse = (error: string, status: number): AdminSessionResult => ({
  ok: false,
  response: NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } }),
});

/** `action` names the admin act for the `admin.action` log (for example `ai_access.list`). */
export async function requireAdminSession(_request: Request, action: string): Promise<AdminSessionResult> {
  const container = getContainer();

  // A key-store outage or a rate-limited key is unavailable, never a pass.
  const user = await getSessionUser().catch(() => "unavailable" as const);
  if (user === "unavailable") return refuse("authz_unavailable", 503);
  if (!user) return refuse("unauthorized", 401);
  const via = user.via === "session" ? "session" : "bearer";

  const allowed: "allow" | "denied" | "unavailable" =
    via === "session"
      ? await container.nodeAdmin
          .check({ userId: user.id, walletAddress: user.walletAddress })
          .then((d) => (d.ok ? "allow" : d.errorCode === "authz_unavailable" ? "unavailable" : "denied"))
          .catch(() => "unavailable" as const)
      : await container.agentAuthority.adminCheck(user.id).catch(() => "unavailable" as const);
  if (allowed === "unavailable") return refuse("authz_unavailable", 503);
  if (allowed !== "allow") return refuse("authz_denied", 403);

  container.log.info({ event: EVENT_NAMES.ADMIN_ACTION, action, adminUserId: user.id, via }, EVENT_NAMES.ADMIN_ACTION);
  return { ok: true, session: Object.freeze({ userId: user.id }) as AdminSession };
}
