// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/orgs/routes`
 * Purpose: The route builders of the org account pages (human plane, session only): "Your orgs", one org account, grant and remove `org:spend`. Each resolves who the caller is,
 *   then hands the call to its `@cogni/agent-grants/http` core (task.0181).
 * Scope: Next-side wiring only. Auth and plane checks stay here; every status and body comes from the core.
 * Side-effects: none at import
 * @internal
 */

import { type OrgAuthority, orgSpendHttp, orgsMineHttp, orgViewHttp } from "@cogni/agent-grants/http";
import { NextResponse } from "next/server";

import { httpDeps, readJsonBody, send } from "@/app/_lib/agent-access/respond";
import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });

/** `GET /api/v1/orgs`: the org accounts the signed-in person holds a role on. */
export function orgsMineRoute() {
  return wrapRouteHandlerWithLogging({ routeId: "orgs.mine", auth: { mode: "none" } }, async (ctx, request) => {
    const refused = refuseNonSession(request, ctx.log);
    if (refused) return refused;
    const user = await getSessionUser();
    if (!user || user.via !== "session") return unauthorized();
    const authority: OrgAuthority = getContainer().agentAuthority;
    return send(await orgsMineHttp(httpDeps(ctx.log), { userId: user.id, after: new URL(request.url).searchParams.get("after"), authority }));
  });
}

/** `GET /api/v1/orgs/{orgId}`: one org account page. */
export function orgViewRoute() {
  return wrapRouteHandlerWithLogging<{ params: Promise<{ orgId: string }> }>({ routeId: "orgs.view", auth: { mode: "none" } }, async (ctx, request, _user, context) => {
    const refused = refuseNonSession(request, ctx.log);
    if (refused) return refused;
    const user = await getSessionUser();
    if (!user || user.via !== "session") return unauthorized();
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId } = await context.params;
    const authority: OrgAuthority = getContainer().agentAuthority;
    const params = new URL(request.url).searchParams;
    return send(await orgViewHttp(httpDeps(ctx.log), { userId: user.id, orgUserId: orgId, query: { historyBefore: params.get("historyBefore"), peopleAfter: params.get("peopleAfter") }, authority }));
  });
}

/** `POST` and `DELETE /api/v1/orgs/{orgId}/spend`: an org admin gives or takes `org:spend` for a wallet. The approver is the session; the org is the path. */
export function orgSpendRoute(routeId: string, call: "grant" | "remove") {
  return wrapRouteHandlerWithLogging<{ params: Promise<{ orgId: string }> }>({ routeId, auth: { mode: "none" } }, async (ctx, request, _user, context) => {
    const refused = refuseNonSession(request, ctx.log);
    if (refused) return refused;
    const user = await getSessionUser();
    if (!user || user.via !== "session") return unauthorized();
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId } = await context.params;
    const authority: OrgAuthority = getContainer().agentAuthority;
    return send(await orgSpendHttp(httpDeps(ctx.log), call, { me: { userId: user.id }, orgUserId: orgId, body: await readJsonBody(request), authority }));
  });
}
