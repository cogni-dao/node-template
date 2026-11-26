// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/orgs/disconnect`
 * Purpose: The org's node disconnects, server to server (task.0181): a service assertion (service `org-connect`, scope `org:disconnect`) signed by the org's own key. The org's services
 *   stop at the next call; its admins' roles and the balance stay. Answers the account's status.
 * Scope: Delegation to the `@cogni/agent-grants/http` core. No session: the signed assertion is the credential. Rate limited per IP (`wrapPublicRoute`).
 * Invariants: CONNECT_IS_SERVER_TO_SERVER, EVERY_ACT_LOGGED (`org.disconnected`, once), NO_TOKEN_IN_LOGS.
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgConnectHttp } from "@cogni/agent-grants/http";
import { httpDeps, send } from "@/app/_lib/agent-access/respond";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapPublicRoute(
  { routeId: "orgs.disconnect", cacheTtlSeconds: 0, staleWhileRevalidateSeconds: 0 },
  async (ctx, request) => {
    const authority = getContainer().agentAuthority;
    return send(
      await orgConnectHttp(httpDeps(ctx.log), "disconnect", {
        authorization: request.headers.get("authorization"),
        verify: (token) => authority.verifyOrgCall(token),
        authority,
      })
    );
  }
);
