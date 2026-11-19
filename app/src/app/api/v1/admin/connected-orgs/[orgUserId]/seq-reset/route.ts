// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/connected-orgs/{orgUserId}/seq-reset`
 * Purpose: ADMIN area, PROVIDER side of connect from home (story.0038). A node-admin puts a connected org's stored `seq` back to 1. A signed connect may only rise above the stored seq by a bounded step,
 *   so a stolen customer key cannot burn the integer line; this reset is the way back for a record whose seq was pushed up. Nothing else on the record changes (cap, status and Suspend stay).
 * Scope: HTTP validation and the mint. The handler gets its `AdminSession` from `requireAdminSession()` and calls `NodeAdminPort` with it. No authority logic.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / ONE_ADMIN_CHECK: one admin check, any credential; no caller 401, non-admin 403 `authz_denied` with nothing written, check down 503.
 *   - An unknown org user (no connection record) is 404.
 * Side-effects: IO (service-role database write), logs `admin.action` and `connection.seq_reset`
 * Links: src/app/(admin)/_lib/admin-session.ts, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { connectedOrgSeqResetOperation } from "@cogni/node-contracts";
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
  { routeId: "admin.connected-orgs.seq-reset", auth: { mode: "none" } },
  async (ctx, request, _sessionUser, context) => {
    const admin = await requireAdminSession(request, "connected_orgs.seq_reset");
    if (!admin.ok) return admin.response;
    if (!context) throw new Error("context required for dynamic routes");
    const { orgUserId } = await context.params;
    if (!ORG_USER_ID.test(orgUserId)) return json({ error: "not_found" }, 404);

    try {
      const found = await getContainer().nodeAdminPort.resetConnectedOrgSeq(admin.session, orgUserId);
      if (!found) return json({ error: "not_found" }, 404);
      ctx.log.info({ event: EVENT_NAMES.CONNECTION_SEQ_RESET, orgUserId, adminUserId: admin.session.userId }, EVENT_NAMES.CONNECTION_SEQ_RESET);
      return json(connectedOrgSeqResetOperation.output.parse({ orgUserId, seq: 1 }));
    } catch (error) {
      ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "admin.connected-orgs.seq-reset", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
