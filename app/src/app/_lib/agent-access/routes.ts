// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/agent-access/routes`
 * Purpose: The route builder the person's own agent access table shares (human plane, session only). It resolves who the caller is, then hands the call to its
 *   `@cogni/agent-grants/http` core.
 * Scope: Next-side wiring only. Auth and plane checks stay here; every status and body comes from the core.
 * Side-effects: none at import
 * @internal
 */

import {
  type AgentAccessAuthority,
  type MineCall,
  mineHttp,
} from "@cogni/agent-grants/http";
import { NextResponse } from "next/server";

import { httpDeps, readJsonBody, send } from "@/app/_lib/agent-access/respond";
import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

/** The person's own table, human plane (session only): a bearer is refused with 403 before any read. */
export function mineRoute(routeId: string, call: MineCall, withBody: boolean) {
  return wrapRouteHandlerWithLogging({ routeId, auth: { mode: "none" } }, async (ctx, request) => {
    const refused = refuseNonSession(request, ctx.log);
    if (refused) return refused;
    const user = await getSessionUser();
    if (!user || user.via !== "session")
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
    const authority: AgentAccessAuthority = getContainer().agentAuthority;
    return send(
      await mineHttp(httpDeps(ctx.log), call, {
        me: { userId: user.id, admin: null },
        via: "session",
        ...(withBody ? { body: await readJsonBody(request) } : {}),
        authority,
      })
    );
  });
}
