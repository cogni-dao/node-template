// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/connected-orgs`
 * Purpose: ADMIN area, PROVIDER side of connect from home (story.0038). A node-admin lists the customer nodes that connected to this node: issuer, status, allowance (the record's
 *   balance), cumulative debits, the customer's cap and the last billed call, on `/admin/connected-orgs`. Bounded and paged by issuer.
 * Scope: HTTP validation and the mint. The handler gets its `AdminSession` from `requireAdminSession()` and calls `NodeAdminPort` with it. No authority logic.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / ONE_ADMIN_CHECK: one admin check, any credential (a session or a bearer); no caller 401, non-admin 403 `authz_denied`, check down 503 `authz_unavailable`.
 *   - BOUNDED_PAGED: `limit` is 1 to 100 (default 50); `after` is the previous page's `nextAfter` (an issuer). A page never holds more than `limit` rows.
 * Side-effects: IO (service-role database read), logs `admin.action`
 * Links: src/app/(admin)/_lib/admin-session.ts, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { connectedOrgsListOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const GET = wrapRouteHandlerWithLogging({ routeId: "admin.connected-orgs.list", auth: { mode: "none" } }, async (ctx, request) => {
  const admin = await requireAdminSession(request, "connected_orgs.list");
  if (!admin.ok) return admin.response;
  const url = new URL(request.url);
  const parsed = connectedOrgsListOperation.input.safeParse({
    ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {}),
    ...(url.searchParams.has("after") ? { after: url.searchParams.get("after") } : {}),
  });
  if (!parsed.success) return json({ error: "invalid input" }, 400);
  try {
    const page = await getContainer().nodeAdminPort.listConnectedOrgs(admin.session, parsed.data);
    return json(connectedOrgsListOperation.output.parse(page));
  } catch (error) {
    ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "admin.connected-orgs.list", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
    return json({ error: "authz_unavailable" }, 503);
  }
});
