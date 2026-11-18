// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/me`
 * Purpose: The self-check. Any caller, session or bearer, reads who it is: kind, bound wallets, whether the node-admin
 *   check passes, and its live grants.
 * Scope: Read-only, own data. Delegates every decision to the agent authority; decides nothing itself.
 * Invariants:
 *   - ONE_ADMIN_CHECK: `isAdmin` is the same `adminCheck` the admin mint and the tool guard use, on the caller's bound wallets,
 *     so this probe and an admin route always agree for the same caller.
 *   - KIND_IS_THE_PRINCIPAL: `kind` is `agent` when the user has an `agent_principals` row; a signed v1 key with no row is
 *     `legacy_agent` (it only comes from agent registration); else `human`. `via` is the credential.
 *   - OWN_DATA_ONLY: the caller's own user id is the only input; the response names no other principal.
 *   - FAIL_CLOSED_NON_DISCLOSING: a store or admin outage is 503 `authz_unavailable`, never a partial answer.
 * Side-effects: IO (service-role database reads)
 * Links: https://node-template.cognidao.org/knowledge/identity-north-star-design, task.0141
 * @public
 */

import { NextResponse } from "next/server";

import { isRevocableKey } from "@cogni/agent-grants/credentials";

import { currentBearerToken } from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.me", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser) => {
    const via = sessionUser.via === "session" ? "session" : "bearer";
    const bearer = via === "bearer" ? await currentBearerToken() : null;
    const legacy = bearer !== null && !isRevocableKey(bearer);
    try {
      const authority = getContainer().agentAuthority;
      // One read at a time: a self-check holds at most one pooled connection, so it never adds pool pressure.
      const agent = await authority.isAgent(sessionUser.id);
      const wallets = await authority.boundWallets(sessionUser.id);
      const admin = await authority.adminCheck(sessionUser.id);
      const rows = await authority.listOwnAccess(sessionUser.id);
      if (admin === "unavailable") return json({ error: "authz_unavailable" }, 503);
      return json({
        userId: sessionUser.id,
        // Kind comes from the principal (an agent_principals row), never from the credential (AUTHORITY_IS_NOT_KIND). One
        // exception the standard names: a signed v1 key is issued only by agent registration and its agent has no principal row
        // until it upgrades, so it reads `legacy_agent`, never `human` (human-ai-identity-standard §4).
        kind: agent ? "agent" : legacy ? "legacy_agent" : "human",
        via,
        wallets,
        isAdmin: admin === "allow",
        grants: rows
          .filter((row) => row.state === "granted")
          .map((row) => ({ scope: row.scope, accountId: row.accountId, since: row.at })),
      });
    } catch (error) {
      ctx.log.error(
        { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "agent.me", ...failureFields(error) },
        EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
      );
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
