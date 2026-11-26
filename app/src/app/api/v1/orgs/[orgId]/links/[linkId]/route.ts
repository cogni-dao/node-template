// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]/links/[linkId]`
 * Purpose: An org OWNER unlinks a node: DELETE (task.0181). The link closes and its payer bindings end, so the next run that node's AI starts is refused with `org_link_closed`.
 * Scope: HTTP only. A person's cookie session only.
 * Invariants: ONLY_AN_OWNER_UNLINKS (an admin is 403 `not_allowed`, a stranger 404); an unknown or already closed link is 404 `link_not_found`. The other node can also unlink by signing
 *   (`POST /api/v1/orgs/link`).
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgUnlinkOperation } from "@cogni/node-contracts";
import { json, orgFailure } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ orgId: string; linkId: string }> };

export const DELETE = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.links.close", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId, linkId } = await context.params;
    try {
      const closed = await getContainer().orgAccounts.closeLink({ actorUserId: sessionUser.id, orgUserId: orgId, linkId });
      return json(orgUnlinkOperation.output.parse({ unlinked: true, closedBindings: closed.closedBindings }));
    } catch (error) {
      return orgFailure(ctx, "orgs.links.close", error);
    }
  }
);
