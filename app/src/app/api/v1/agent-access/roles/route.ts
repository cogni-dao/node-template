// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent-access/roles`
 * Purpose: HUMAN plane. A DAO admin, signed in, lists this node's AI and allows (POST) or removes (DELETE) a permission by
 *   clicking on the profile page. GET returns `canManage`; a non-admin gets `canManage: false` and no AI.
 * Scope: HTTP validation, the human-plane guard, the node admin gate, and delegation to the agent authority. No authority logic.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header gets 403 `human_session_required` (checked before anything else).
 *   - ADMIN_ONLY_FROM_DAO: only a caller the node admin gate approves may write a role. Admin is any principal the DAO
 *     approves (AUTHORITY_IS_NOT_KIND); AGENTS_HOLD_NO_WALLET is a payout guard, not an authority rule.
 *   - FAIL_CLOSED_WITH_DISTINCTION: non-admin write is 403 `authz_denied`; no configured admins is 503 `authz_unavailable`.
 *   - NODE_DECLARED_SCOPES: an undeclared scope is 400 before any write.
 *   - Logs `agent_role.granted` / `agent_role.revoked`; no secrets.
 * Side-effects: IO (service-role database read and write)
 * Links: packages/agent-grants, src/bootstrap/agent-authority.ts, https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import { agentRolesListOperation, agentRolesOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Authority = ReturnType<typeof getContainer>["agentAuthority"];
type Writer = (
  authority: Authority,
  input: { principalSlug: string; scope: string; adminUserId: string }
) => Promise<{ principalUserId: string; changed: boolean }>;

const NO_STORE = { "cache-control": "no-store" } as const;
/** Every response, errors included, is `no-store`. */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.access.roles.list", auth: { mode: "optional", getSessionUser } },
  async (ctx, request, sessionUser) => {
    const refused = refuseNonSession(request, ctx.log);
    if (refused) return refused;
    if (!sessionUser) return json({ error: "unauthorized" }, 401);

    const authority = getContainer().agentAuthority;
    const admin = await authority.adminCheck(sessionUser.id).catch(() => "unavailable" as const);
    if (admin === "unavailable") {
      ctx.log.warn({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "agent.access.roles.list" }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
      return json({ error: "authz_unavailable" }, 503);
    }
    if (admin !== "allow") {
      return json(agentRolesListOperation.output.parse({ canManage: false, permissions: [] }));
    }
    try {
      return json(agentRolesListOperation.output.parse({ canManage: true, permissions: await authority.listNodeAi() }));
    } catch (error) {
      ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_LIST_FAILED, routeId: "agent.access.roles.list", errorName: error instanceof Error ? error.name : "unknown" }, EVENT_NAMES.AGENT_ROLES_LIST_FAILED);
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);

function writeRoute(routeId: string, write: Writer) {
  return wrapRouteHandlerWithLogging(
    { routeId, auth: { mode: "optional", getSessionUser } },
    async (ctx, request, sessionUser) => {
      const refused = refuseNonSession(request, ctx.log);
      if (refused) return refused;
      if (!sessionUser) return json({ error: "unauthorized" }, 401);
      const authority = getContainer().agentAuthority;

      const admin = await authority.adminCheck(sessionUser.id).catch(() => "unavailable" as const);
      if (admin === "unavailable") {
        ctx.log.warn({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
        return json({ error: "authz_unavailable" }, 503);
      }
      if (admin !== "allow") {
        ctx.log.warn({ event: EVENT_NAMES.AGENT_ROLES_REFUSED, routeId, userId: sessionUser.id }, EVENT_NAMES.AGENT_ROLES_REFUSED);
        return json({ error: "authz_denied" }, 403);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const parsed = agentRolesOperation.input.safeParse(body);
      if (!parsed.success) {
        return json({ error: "invalid input", issues: parsed.error.issues }, 400);
      }

      try {
        const result = await write(authority, {
          principalSlug: parsed.data.principal,
          scope: parsed.data.scope,
          adminUserId: sessionUser.id,
        });
        return json(
          agentRolesOperation.output.parse({ principal: parsed.data.principal, scope: parsed.data.scope, ...result })
        );
      } catch (error) {
        if (error instanceof AgentRolesError) {
          return json({ error: error.code }, error.code === "principal_not_found" ? 404 : 400);
        }
        throw error;
      }
    }
  );
}

export const POST = writeRoute("agent.access.roles.grant", async (authority, input) => {
  const { principalUserId, created } = await authority.grantRole({
    principalSlug: input.principalSlug,
    scope: input.scope,
    approvedBy: input.adminUserId,
  });
  return { principalUserId, changed: created };
});

export const DELETE = writeRoute("agent.access.roles.revoke", async (authority, input) => {
  const { principalUserId, revoked } = await authority.revokeRole({
    principalSlug: input.principalSlug,
    scope: input.scope,
    revokedBy: input.adminUserId,
  });
  return { principalUserId, changed: revoked };
});
