// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]/links`
 * Purpose: An owner or admin reads the org's open node links a page at a time: GET `?limit=&cursor=` (task.0181).
 * Scope: HTTP only. A person's cookie session only. The least role is `admin`; only an owner may unlink (`DELETE /links/{linkId}`).
 * Invariants: LISTS_PAGE (a page is at most 100 rows; nothing is cut silently); NON_DISCLOSING (a stranger and an unknown org are 404).
 * Side-effects: IO (service-role database read)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgLinksListOperation } from "@cogni/node-contracts";
import { json, orgFailure, pageQuery } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ orgId: string }> };

export const GET = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.links.list", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId } = await context.params;
    const query = pageQuery(request);
    if (!query) return json({ error: "invalid input" }, 400);
    try {
      const page = await getContainer().orgAccounts.links(sessionUser.id, orgId, query);
      return json(
        orgLinksListOperation.output.parse({
          items: page.items.map((l) => ({ id: l.id, issuer: l.issuer, services: [...l.services], createdAt: l.createdAt })),
          nextCursor: page.nextCursor,
        })
      );
    } catch (error) {
      return orgFailure(ctx, "orgs.links.list", error);
    }
  }
);
