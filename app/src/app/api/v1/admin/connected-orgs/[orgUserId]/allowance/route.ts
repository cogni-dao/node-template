// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/connected-orgs/{orgUserId}/allowance`
 * Purpose: ADMIN area, PROVIDER side of connect from home (story.0038). A node-admin grants a connected org an allowance in credits: ONE credit-ledger row (reason
 *   `connection_allowance`) on the record's billing account, through the existing accounts adapter. The allowance is the provider's own money decision; the customer's cap only lowers it.
 * Scope: HTTP validation and the mint. The handler gets its `AdminSession` from `requireAdminSession()` and calls `NodeAdminPort` with it. No authority logic.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / ONE_ADMIN_CHECK: one admin check, any credential; no caller 401, non-admin 403 `authz_denied` with nothing written, check down 503. A bearer reaches it only through the one
 *     admin check on its bound wallets (no new grant, no tool twin: the route is admin-only).
 *   - IDEMPOTENT: an `Idempotency-Key` header (1 to 100 visible characters) makes a retry add nothing (`applied: false`); with no header every call is its own grant.
 *   - An unknown org user (no connection record) is 404; `credits` is an integer of at least 1.
 * Side-effects: IO (service-role database write through the accounts adapter), logs `admin.action` and `connection.allowance_granted`
 * Links: src/app/(admin)/_lib/admin-session.ts, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { connectedOrgAllowanceOperation } from "@cogni/node-contracts";
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
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,100}$/;

export const POST = wrapRouteHandlerWithLogging<{ params: Promise<{ orgUserId: string }> }>(
  { routeId: "admin.connected-orgs.allowance", auth: { mode: "none" } },
  async (ctx, request, _sessionUser, context) => {
    const admin = await requireAdminSession(request, "connected_orgs.allowance");
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
    const parsed = connectedOrgAllowanceOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    const header = request.headers.get("idempotency-key");
    if (header !== null && !IDEMPOTENCY_KEY.test(header)) return json({ error: "invalid_idempotency_key" }, 400);

    try {
      const granted = await getContainer().nodeAdminPort.grantConnectionAllowance(admin.session, {
        orgUserId,
        credits: parsed.data.credits,
        key: header ?? crypto.randomUUID(),
      });
      if (!granted) return json({ error: "not_found" }, 404);
      ctx.log.info(
        { event: EVENT_NAMES.CONNECTION_ALLOWANCE_GRANTED, orgUserId, credits: parsed.data.credits, applied: granted.applied, adminUserId: admin.session.userId },
        EVENT_NAMES.CONNECTION_ALLOWANCE_GRANTED
      );
      return json(connectedOrgAllowanceOperation.output.parse({ orgUserId, allowance: granted.allowance, applied: granted.applied }));
    } catch (error) {
      ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "admin.connected-orgs.allowance", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
