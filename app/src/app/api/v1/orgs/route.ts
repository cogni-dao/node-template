// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs`
 * Purpose: A signed-in person lists the orgs they are in, a page at a time (GET `?limit=&cursor=`), and creates one (POST `{ name }`): the org's account, its `org` principal and the creator's `org:owner` (task.0181).
 * Scope: HTTP validation and delegation to `container.orgAccounts`. A person's cookie session only (the human plane); the caller is never a body field. The org is made by the package's
 *   `createOrg` in one transaction.
 * Invariants:
 *   - ANYONE_CREATES: any signed-in person may create an org on any node. It grants nothing outside the org: no node permission, no data access.
 *   - BOUNDED_CREATION (release 1): a person holds each org role in at most one org, so a second org is 409 `org_role_limit` (release 2 raises it to 5 owned orgs).
 *   - This route replaces the retired `POST /api/v1/orgs` that registered an org for a repo-spec owner source (agent-grants 0.10.0 deletes that source).
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgCreateOperation, orgListOperation } from "@cogni/node-contracts";
import { json, orgFailure, pageQuery, readJson } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "orgs.list", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, request, sessionUser) => {
    const query = pageQuery(request);
    if (!query) return json({ error: "invalid input" }, 400);
    try {
      const page = await getContainer().orgAccounts.list(sessionUser.id, query);
      return json(
        orgListOperation.output.parse({
          orgs: page.items.map((o) => ({ orgUserId: o.orgUserId, name: o.name, billingAccountId: o.billingAccountId, balanceCredits: o.balanceCredits, suspended: o.suspendedAt !== null, role: o.role })),
          nextCursor: page.nextCursor,
        })
      );
    } catch (error) {
      return orgFailure(ctx, "orgs.list", error);
    }
  }
);

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "orgs.create", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, request, sessionUser) => {
    const parsed = orgCreateOperation.input.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    try {
      const org = await getContainer().orgAccounts.create(sessionUser.id, parsed.data.name);
      return json(orgCreateOperation.output.parse(org), 201);
    } catch (error) {
      return orgFailure(ctx, "orgs.create", error);
    }
  }
);
