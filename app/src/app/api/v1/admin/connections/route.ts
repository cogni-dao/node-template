// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/connections`
 * Purpose: ADMIN area, CUSTOMER side of connect from home (story.0038). A node-admin lists the providers `.cogni/service-links.yaml` names as targets with this node's own state
 *   (status, cap) and the static offer text from config (GET), and connects (with a cap) or disconnects (POST) from `/admin/connections`: this node signs ONE assertion as service
 *   `node-connect` with `act`, `cap` and a rising `seq`, posts it to the provider and returns the provider's answer.
 * Scope: HTTP validation and the mint. Every handler gets its `AdminSession` from `requireAdminSession()` and calls `NodeAdminPort` with it. No authority logic.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / ONE_ADMIN_CHECK: one admin check, any credential (a session or a bearer); no caller 401, non-admin 403 `authz_denied` with nothing signed or sent, check down 503.
 *   - ALIAS_FROM_SERVER_CONFIG: the alias names a configured target, never a URL: an unknown alias is 404 `unknown_alias`.
 *   - NO_SIGNER: a node with no signing key cannot connect: POST is 503 `signer_unavailable`, and GET says `signer: false` so the page can say so.
 *   - NOTHING_IS_GRANTED: the provider's answer is shown as it is (its HTTP status, its status or its plain error code); this node never writes the provider's records.
 * Side-effects: IO (service-role database read and write, one signed HTTPS POST to a configured node), logs `admin.action` and `connection.sent`
 * Links: src/app/(admin)/_lib/admin-session.ts, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { connectionActOperation, connectionsListOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const GET = wrapRouteHandlerWithLogging({ routeId: "admin.connections.list", auth: { mode: "none" } }, async (ctx, request) => {
  const admin = await requireAdminSession(request, "connections.list");
  if (!admin.ok) return admin.response;
  try {
    const view = await getContainer().nodeAdminPort.listOutboundConnections(admin.session);
    return json(connectionsListOperation.output.parse(view));
  } catch (error) {
    ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "admin.connections.list", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
    return json({ error: "authz_unavailable" }, 503);
  }
});

export const POST = wrapRouteHandlerWithLogging({ routeId: "admin.connections.act", auth: { mode: "none" } }, async (ctx, request) => {
  const admin = await requireAdminSession(request, "connections.act");
  if (!admin.ok) return admin.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const parsed = connectionActOperation.input.safeParse(body);
  if (!parsed.success) return json({ error: "invalid input" }, 400);

  try {
    const result = await getContainer().nodeAdminPort.actOutboundConnection(admin.session, parsed.data);
    if (!result.ok) {
      if (result.reason === "unknown_alias") return json({ error: "unknown_alias" }, 404);
      if (result.reason === "no_signer") return json({ error: "signer_unavailable" }, 503);
      return json({ error: "target_unreachable" }, 502);
    }
    return json(
      connectionActOperation.output.parse({
        alias: result.alias,
        act: result.act,
        httpStatus: result.httpStatus,
        status: result.status,
        error: result.error,
        target: result.target,
      })
    );
  } catch (error) {
    ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "admin.connections.act", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
    return json({ error: "authz_unavailable" }, 503);
  }
});
