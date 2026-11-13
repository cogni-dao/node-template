// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/ai-access/requests/[id]`
 * Purpose: ADMIN area, human plane. The node-admin's approval page for ONE ask (`/admin/ai-access/requests/<id>`): GET reads only that request. The click is the existing
 *   `/api/v1/admin/ai-access` POST (On) or DELETE (Off, or `deny: true`), which re-checks admin on every call.
 * Scope: HTTP only. The mint (`requireAdminSession`) re-checks admin here too; the read goes through `NodeAdminPort`.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required`; a non-admin is 403 `authz_denied`.
 *   - APPROVER_FOLLOWS_RESOURCE: an admin sees a node row only. A personal row, and an ask of an owned agent for a delegable scope (the owner decides), are 404 `not_found`.
 *   - NEVER_CACHED: every response is `no-store`.
 * Side-effects: IO (service-role database read)
 * Links: src/ports/node-admin.port.ts, https://cognidao.org/work/items/task.5465
 * @public
 */

import { agentRequestViewOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export const GET = wrapRouteHandlerWithLogging<{ params: Promise<{ id: string }> }>(
  { routeId: "admin.ai-access.request.view", auth: { mode: "none" } },
  async (_ctx, request, _user, context) => {
    const admin = await requireAdminSession(request, "ai_access.request.view");
    if (!admin.ok) return admin.response;
    if (!context) throw new Error("route_context_missing");
    const { id } = await context.params;
    try {
      const view = await getContainer().nodeAdminPort.getAiRequest(admin.session, id);
      return view ? json(agentRequestViewOperation.output.parse(view)) : json({ error: "not_found" }, 404);
    } catch {
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
