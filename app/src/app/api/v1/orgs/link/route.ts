// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/link`
 * Purpose: Another node links to an org on this node, or unlinks, by signing (task.0181): `Authorization: Bearer <assertion>` signed as that node's service `node-connect` with
 *   `act: "link"` and a one-time code, or `act: "unlink"`. This node verifies it against the issuer's keys at `<origin>/.well-known/jwks.json`, then writes the link and the payer bindings.
 * Scope: HTTP, the bearer and delegation to `container.orgAccounts.applyLink`. No session (the public wrapper: the signature is the credential). The body is `{}`; every value that
 *   matters is a signed claim.
 * Invariants:
 *   - LINK_NEEDS_BOTH_SIDES: an org owner's code made here AND the other node's signature. This node never acts on an unsigned claim about the other node.
 *   - FAIL_CLOSED: an unreadable, unverifiable, expired, replayed or wrong-audience assertion is 401 `invalid_token`; a used, expired or unknown code is 400 `link_code_invalid`; an origin that
 *     already has an open link is 409 `issuer_already_linked`; an unlink with no open link is 404 `no_open_link`; a suspended org is 403 `org_suspended`; an unreachable key set is
 *     503 `jwks_unavailable`; a store failure is 503 `authz_unavailable`.
 *   - NO_TOKEN_IN_LOGS: `org.linked` and `org.refused` carry ids, the issuer and a short code, never the assertion or the code.
 * Side-effects: IO (service-role database writes, one key fetch from the issuer's origin)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgLinkOperation } from "@cogni/node-contracts";
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

const REFUSAL_STATUS = {
  malformed: 400,
  invalid_assertion: 401,
  jwks_unavailable: 503,
  link_code_invalid: 400,
  issuer_already_linked: 409,
  no_open_link: 404,
  org_suspended: 403,
} as const;

// wrapPublicRoute: rate limited per IP, no session (the signed assertion is the credential). A POST answer is never cached.
export const POST = wrapPublicRoute(
  { routeId: "orgs.link", cacheTtlSeconds: 0, staleWhileRevalidateSeconds: 0 },
  async (ctx, request) => {
    const token = bearerOf(request);
    if (!token) return json({ error: "invalid_token" }, 401);
    const body: unknown = await request.json().catch(() => ({}));
    if (!orgLinkOperation.input.safeParse(body).success) return json({ error: "invalid input" }, 400);
    try {
      const result = await getContainer().orgAccounts.applyLink(token);
      if (!result.ok) return json({ error: result.code === "invalid_assertion" ? "invalid_token" : result.code }, REFUSAL_STATUS[result.code]);
      return json(orgLinkOperation.output.parse({ act: result.act, orgUserId: result.orgUserId, services: [...result.services], linkId: result.linkId }), result.act === "link" ? 201 : 200);
    } catch (error) {
      ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "orgs.link", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
