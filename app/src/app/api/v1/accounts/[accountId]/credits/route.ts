// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/accounts/[accountId]/credits`
 * Purpose: The credit balance of ONE account. The owner reads their own. An AI reads its owner's only after the owner turned the personal `account:read`
 *   permission On on their profile (Your AIs); Off, expired, another person's account and an AI with no owner are all the same 404.
 * Scope: Auth (session or bearer), the account door (`authorizeAccount`), then one read through RLS. No authority logic here.
 * Invariants:
 *   - ACCOUNT_SCOPE_NEEDS_OWNER_GRANT + FAIL_CLOSED_NON_DISCLOSING: every denial is 404 `not_found`, so the answer never says whether the account exists.
 *     A store outage is 503 `authz_unavailable`, never an allow.
 *   - ACCOUNT_NAMED_BY_THE_PATH: the account is the path value. The agent learns it from its own access list once the owner says yes.
 *   - RLS_BACKSTOP: the balance is read with the CALLER as the database context user. The database applies the same live-grant rule (`agent_has_scope`) again.
 *   - NEVER_CACHED: every response is `no-store`.
 * Side-effects: IO (database reads), logs `agent_tool.authz` with the route id
 * Links: packages/agent-grants (authorizeAccount), src/app/_facades/accounts/credits.server.ts, https://cognidao.org/knowledge/node-capability-grants-standard (A5)
 * @public
 */

import { accountCreditsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { getAccountBalanceFacade } from "@/app/_facades/accounts/credits.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export const GET = wrapRouteHandlerWithLogging<{ params: Promise<{ accountId: string }> }>(
  { routeId: "accounts.credits.read", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, sessionUser, context) => {
    if (!sessionUser) return json({ error: "unauthorized" }, 401);
    if (!context) throw new Error("route_context_missing");
    const { accountId } = await context.params;

    const access = await getContainer().agentAuthority.authorizeAccount({
      capabilityId: "account.read",
      routeId: "accounts.credits.read",
      userId: sessionUser.id,
      // Fail closed: only an identity that says `session` takes the human rules. Anything else is a delegate and needs a grant.
      via: sessionUser.via === "session" ? "session" : "bearer",
      accountId,
    });
    if (!access.ok)
      return access.code === "authz_unavailable"
        ? json({ error: "authz_unavailable", code: "authz_unavailable" }, 503)
        : json({ error: "not_found" }, 404);

    const balance = await getAccountBalanceFacade({ callerUserId: sessionUser.id, accountId });
    // The database showed the caller no such row: the same 404 as a denial.
    if (!balance) return json({ error: "not_found" }, 404);
    return json(accountCreditsOperation.output.parse(balance));
  }
);
