// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/connected-orgs/{orgUserId}/suspension`
 * Purpose: ADMIN area, PROVIDER side of connect from home (story.0038). A node-admin Suspends (`{ suspended: true }`) or Resumes (`false`) a connected org. A Suspended record refuses every run
 *   billed to it on the next call, whatever the customer does: a connect never clears it (SUSPEND_IS_STICKY); only this route's Resume does.
 * Scope: HTTP validation and the mint. The handler gets its `AdminSession` from `requireAdminSession()` and calls `NodeAdminPort` with it. No authority logic.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / ONE_ADMIN_CHECK: one admin check, any credential; no caller 401, non-admin 403 `authz_denied` with nothing written, check down 503.
 *   - An unknown org user (no connection record) is 404.
 * Side-effects: IO (service-role database write), logs `admin.action` and `connection.suspension`
 * Links: src/app/(admin)/_lib/admin-session.ts, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { connectedOrgSuspensionOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const ORG_USER_ID = /^[A-Za-z0-9-]{1,100}$/;

export const POST = wrapRouteHandlerWithLogging<{ params: Promise<{ orgUserId: string }> }>(
  { routeId: "admin.connected-orgs.suspension", auth: { mode: "none" } },
  async (ctx, request, _sessionUser, context) => {
    const admin = await requireAdminSession(request, "connected_orgs.suspension");
    if (!admin.ok) return admin.response;
    if (!context) throw new Error("context required for dynamic routes");
    const { orgUserId } = await context.params;
    if (!ORG_USER_ID.test(orgUserId)) return json({ error: "not_found" }, 404);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = connectedOrgSuspensionOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input" }, 400);

    try {
      const found = await getContainer().nodeAdminPort.setConnectedOrgSuspended(admin.session, { orgUserId, suspended: parsed.data.suspended });
      if (!found) return json({ error: "not_found" }, 404);
      ctx.log.info(
        { event: EVENT_NAMES.CONNECTION_SUSPENSION, orgUserId, suspended: parsed.data.suspended, adminUserId: admin.session.userId },
        EVENT_NAMES.CONNECTION_SUSPENSION
      );
      return json(connectedOrgSuspensionOperation.output.parse({ orgUserId, suspended: parsed.data.suspended }));
    } catch (error) {
      ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "admin.connected-orgs.suspension", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
