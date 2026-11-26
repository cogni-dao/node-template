// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/_lib/orgs-route`
 * Purpose: The route builders of the two admin org surfaces (task.0181): this node's admin lists org accounts and suspends or restores one with a reason (`/admin` org accounts), and
 *   this node as an org lists, connects and disconnects its accounts on other nodes (its governance page). The one admin mint decides first; the `@cogni/agent-grants/http` core runs the call.
 * Scope: Next-side wiring only. Lives in the Admin route area (ADMIN_ACTS_IN_ADMIN).
 * Side-effects: none at import
 * @internal
 */

import { adminOrgsHttp, orgConnectionsHttp } from "@cogni/agent-grants/http";

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { httpDeps, readJsonBody, send } from "@/app/_lib/agent-access/respond";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

/** `GET /api/v1/admin/orgs` and `POST /api/v1/admin/orgs/{orgId}/suspension`. */
export function adminOrgsRoute(routeId: string, action: string, call: "list" | "set") {
  return wrapRouteHandlerWithLogging<{ params: Promise<{ orgId: string }> }>({ routeId, auth: { mode: "none" } }, async (ctx, request, _user, context) => {
    const admin = await requireAdminSession(request, action);
    if (!admin.ok) return admin.response;
    const orgUserId = call === "set" && context ? (await context.params).orgId : undefined;
    return send(
      await adminOrgsHttp(httpDeps(ctx.log), call, {
        adminUserId: admin.session.userId,
        ...(orgUserId ? { orgUserId } : {}),
        after: call === "list" ? new URL(request.url).searchParams.get("after") : null,
        ...(call === "set" ? { body: await readJsonBody(request) } : {}),
        authority: getContainer().agentAuthority,
      })
    );
  });
}

/** `GET`, `POST` and `DELETE /api/v1/admin/org-connections`: the org's own admin connects to, lists and disconnects from other nodes. */
export function orgConnectionsRoute(routeId: string, action: string, call: "list" | "connect" | "disconnect") {
  return wrapRouteHandlerWithLogging({ routeId, auth: { mode: "none" } }, async (ctx, request) => {
    const admin = await requireAdminSession(request, action);
    if (!admin.ok) return admin.response;
    return send(
      await orgConnectionsHttp(httpDeps(ctx.log), call, {
        adminUserId: admin.session.userId,
        ...(call === "list" ? { after: new URL(request.url).searchParams.get("after") } : { body: await readJsonBody(request) }),
        authority: getContainer().agentAuthority.orgConnections,
      })
    );
  });
}
