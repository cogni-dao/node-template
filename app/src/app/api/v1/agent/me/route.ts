// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/me`
 * Purpose: The self-check. Any caller, session or bearer, reads who it is: its bound wallets, whether the node-admin
 *   check passes, and its live grants.
 * Scope: Read-only, own data. Delegates every decision to the agent authority; decides nothing itself.
 * Invariants:
 *   - ONE_ADMIN_CHECK: `isAdmin` is the same `adminCheck` the admin mint and the tool guard use, on the caller's bound wallets,
 *     so this probe and an admin route always agree for the same caller.
 *   - `via` is the credential; `kind` is `org` for an org principal, `agent` for any other `agent_principals` row (written at registration, backfilled for earlier agents), else `human`.
 *   - OWN_DATA_ONLY: the caller's own user id is the only input; the response names no other principal.
 *   - FAIL_CLOSED_NON_DISCLOSING: a store or admin outage is 503 `authz_unavailable`, never a partial answer.
 * Side-effects: IO (service-role database reads)
 * Links: https://node-template.cognidao.org/knowledge/identity-north-star-design, task.0141
 * @public
 */

import { agentMeHttp } from "@cogni/agent-grants/http";

import { httpDeps, send } from "@/app/_lib/agent-access/respond";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.me", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser) =>
    send(
      await agentMeHttp(httpDeps(ctx.log), {
        userId: sessionUser.id,
        via: sessionUser.via === "session" ? "session" : "bearer",
        authority: getContainer().agentAuthority,
      })
    )
);
