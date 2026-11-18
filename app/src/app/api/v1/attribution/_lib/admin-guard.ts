// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/_lib/admin-guard`
 * Purpose: The attribution routes' node-admin gate: a thin wrapper over the one admin check, `agentAuthority.adminCheck`.
 * Scope: Maps the check's decision to this family's responses (403 not an approver, 503 check unavailable). Authenticates nothing: the route wrapper already 401s.
 * Invariants: WRITE_ROUTES_APPROVER_GATED; ONE_ADMIN_CHECK (the caller's bound wallets against repo-spec approvers, the same answer for a session and a bearer; the login wallet on the session never decides).
 *   An epoch's pinned approver set is enforced where the signature is verified (`finalizeEpochInProcess`), not here.
 * Side-effects: IO (bound-wallet read)
 * Links: src/bootstrap/agent-authority.ts, tests/unit/app/attribution-admin-guard.test.ts
 * @internal
 */

import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import type { RequestContext } from "@/shared/observability";
import { logRequestWarn } from "@/shared/observability";

/** Returns a 403 or 503 response unless the caller passes the one admin check; null means authorized. */
export async function denyUnlessNodeAdmin(
  ctx: RequestContext,
  user: { readonly id: string }
): Promise<NextResponse | null> {
  const decision = await getContainer()
    .agentAuthority.adminCheck(user.id)
    .catch(() => "unavailable" as const);
  if (decision === "allow") return null;
  if (decision === "unavailable") {
    logRequestWarn(
      ctx.log,
      { userId: user.id },
      "LEDGER_ADMIN_CHECK_UNAVAILABLE"
    );
    return NextResponse.json({ error: "authz_unavailable" }, { status: 503 });
  }
  logRequestWarn(ctx.log, { userId: user.id }, "LEDGER_NOT_APPROVER");
  return NextResponse.json(
    { error: "Not authorized as ledger approver" },
    { status: 403 }
  );
}
