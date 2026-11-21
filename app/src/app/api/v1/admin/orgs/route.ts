// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/orgs`
 * Purpose: ADMIN area. A node-admin, signed in, lists EVERY org on this node a page at a time: GET `?limit=&cursor=` answers `{ orgs: [{ orgUserId, name, suspended }], nextCursor }`
 *   (task.0181), so the admin's account list can offer Suspend for an org (`POST /api/v1/orgs/{orgId}/suspension`).
 * Scope: HTTP validation and the mint. The handler gets its `AdminSession` from `requireAdminSession()`, which runs the one node-admin check on the caller's wallet; the list itself is
 *   `container.orgAccounts.listAll`. No authority logic.
 * Invariants:
 *   - ONE_ADMIN_CHECK: a session or a bearer reaches the mint, which runs the one node-admin check. A non-admin is 403 `authz_denied`; no configured admins 503 `authz_unavailable`.
 *   - LISTS_PAGE: a page is at most 100 rows (`?limit=` is 1..100, default 50); `nextCursor` reaches every org exactly once; nothing is cut silently.
 *   - A list is a read: it writes nothing and every answer is `no-store`.
 * Side-effects: IO (service-role database read), logs `admin.action`
 * Links: src/app/(admin)/_lib/admin-session.ts, https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgAdminListOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { json, orgFailure, pageQuery } from "@/app/api/v1/orgs/_lib/org-http";
import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging({ routeId: "admin.orgs.list", auth: { mode: "none" } }, async (ctx, request): Promise<NextResponse> => {
  const admin = await requireAdminSession(request, "orgs.list");
  if (!admin.ok) return admin.response;
  const query = pageQuery(request);
  if (!query) return json({ error: "invalid input" }, 400);
  try {
    const page = await getContainer().orgAccounts.listAll(query);
    return json(orgAdminListOperation.output.parse({ orgs: page.items, nextCursor: page.nextCursor }));
  } catch (error) {
    return orgFailure(ctx, "admin.orgs.list", error);
  }
});
