// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/agent/service-connections`
 * Purpose: PROVIDER side of connect from home (story.0038, agent-grants 0.9.0). A customer node's admin connects or disconnects from its own Admin page; its node signs ONE assertion as
 *   service `node-connect` whose claims carry `act` (`connect` | `disconnect`), `cap` (integer credits) and a rising `seq`, and posts it here with `Authorization: Bearer <assertion>`.
 *   This node verifies it against the trusted home's published keys, creates or reuses the issuer's ONE customer record, and writes its live state (status, cap, seq).
 * Scope: HTTP, the assertion check and delegation to `container.connections.apply`. No session (the public wrapper, `auth.mode: none`: the signed assertion is the credential). The body is
 *   ignored: the signed claims are the request, so a replayed or edited body changes nothing.
 * Invariants:
 *   - TRUSTED_HOMES_ONLY: an issuer this node does not list under `trusted_homes`, a service it does not allow, a bad signature, an expired or replayed (`jti` stored durably in Postgres)
 *     assertion is 401 `invalid_token` and creates nothing; an unreachable key set or a store failure is 503 `authz_unavailable`.
 *   - ONLY_NODE_CONNECT: an assertion of any other service is 401 here.
 *   - CONNECT_IS_ORDERED: a `seq` at or below the stored one is 409 `stale_seq` with the stored `seq`, and changes nothing (cap included).
 *   - NOTHING_IS_GRANTED: a connect gives the customer no permission and no money: the allowance is the provider admin's own grant, and Suspend is the provider's and sticky.
 * Side-effects: IO (service-role database write, home JWKS fetch)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { NODE_CONNECT_SERVICE } from "@cogni/agent-grants/service-auth";
import { serviceConnectionOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trimStart() || null;
}

// wrapPublicRoute: rate limited per IP, no session (the signed assertion is the credential). A POST answer is never cached.
export const POST = wrapPublicRoute(
  { routeId: "agent.service-connection.apply", cacheTtlSeconds: 0, staleWhileRevalidateSeconds: 0 },
  async (ctx, request) => {
    const token = bearerOf(request);
    if (!token) return json({ error: "invalid_token" }, 401);

    const container = getContainer();
    try {
      const assertion = await container.serviceAuth.verify(token);
      if (!assertion.ok) {
        if (assertion.code === "jwks_unavailable") return json({ error: "authz_unavailable" }, 503);
        return json({ error: "invalid_token" }, 401);
      }
      if (assertion.service !== NODE_CONNECT_SERVICE) return json({ error: "invalid_token" }, 401);

      const outcome = await container.connections.apply(assertion);
      if (!outcome.ok) {
        if (outcome.code === "stale_seq") return json({ error: "stale_seq", ...(outcome.seq !== undefined ? { seq: outcome.seq } : {}) }, 409);
        if (outcome.code === "wrong_service") return json({ error: "invalid_token" }, 401);
        if (outcome.code === "wrong_scope") return json({ error: "invalid_scope" }, 400);
        return json({ error: "invalid_claims" }, 400);
      }
      return json(
        serviceConnectionOperation.output.parse({ status: outcome.record.status, cap: outcome.record.cap, seq: outcome.record.seq }),
        200
      );
    } catch (error) {
      ctx.log.error(
        { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "agent.service-connection.apply", ...failureFields(error) },
        EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
      );
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
