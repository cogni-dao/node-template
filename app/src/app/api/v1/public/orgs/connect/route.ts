// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/orgs/connect`
 * Purpose: The org's node tells this node "I am this org", server to server (task.0181). The bearer is a short-lived service assertion (service `org-connect`, scope `org:connect`,
 *   audience this node's id) signed by the org's own key; its issuer is the org's origin. This node then pulls the org statement at that origin and creates or refreshes the org account.
 * Scope: Delegation to the `@cogni/agent-grants/http` core. No session: the signed assertion is the credential. Rate limited per IP (`wrapPublicRoute`).
 * Invariants: ADMINS_FROM_THE_ORG (admins come only from the statement pulled here), CONNECT_IS_SERVER_TO_SERVER, NO_TOKEN_IN_LOGS. Answers the account's status (including `suspended`).
 * Side-effects: IO (HTTPS to the org's origin, service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-fleet-identity
 * @public
 */

import { orgConnectHttp } from "@cogni/agent-grants/http";
import { httpDeps, send } from "@/app/_lib/agent-access/respond";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapPublicRoute(
  { routeId: "orgs.connect", cacheTtlSeconds: 0, staleWhileRevalidateSeconds: 0 },
  async (ctx, request) => {
    const authority = getContainer().agentAuthority;
    return send(
      await orgConnectHttp(httpDeps(ctx.log), "connect", {
        authorization: request.headers.get("authorization"),
        verify: (token) => authority.verifyOrgCall(token),
        authority,
      })
    );
  }
);
