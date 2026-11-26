// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]/members`
 * Purpose: An owner or admin reads the org's people a page at a time: GET `?limit=&cursor=` (task.0181).
 * Scope: HTTP only. A person's cookie session only. The least role is `admin` (an owner passes too).
 * Invariants: LISTS_PAGE (a page is at most 100 rows; `nextCursor` reaches every row exactly once; nothing is cut silently); NON_DISCLOSING (a stranger and an unknown org are 404).
 * Side-effects: IO (service-role database read)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgMembersListOperation } from "@cogni/node-contracts";
import { json, orgFailure, pageQuery } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ orgId: string }> };

export const GET = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.members.list", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId } = await context.params;
    const query = pageQuery(request);
    if (!query) return json({ error: "invalid input" }, 400);
    try {
      const page = await getContainer().orgAccounts.members(sessionUser.id, orgId, query);
      return json(orgMembersListOperation.output.parse(page));
    } catch (error) {
      return orgFailure(ctx, "orgs.members.list", error);
    }
  }
);
