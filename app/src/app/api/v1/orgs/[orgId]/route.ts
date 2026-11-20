// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]`
 * Purpose: An owner or admin reads one org: its record, their own role, its people and its open node links (task.0181).
 * Scope: HTTP only. The least role is `admin` (an owner passes too: `org:owner` includes `org:admin`), decided by the package from the caller's live grant on the org's account.
 * Invariants: NON_DISCLOSING: a stranger and an unknown org are both 404 `not_found`. Org data is read on the service-role path after that check.
 * Side-effects: IO (service-role database read)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgViewOperation } from "@cogni/node-contracts";
import { json, orgFailure } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ orgId: string }> };

export const GET = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.view", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId } = await context.params;
    try {
      const view = await getContainer().orgAccounts.view(sessionUser.id, orgId);
      return json(
        orgViewOperation.output.parse({
          org: { orgUserId: view.org.orgUserId, name: view.org.name, billingAccountId: view.org.billingAccountId, suspended: view.org.suspendedAt !== null },
          role: view.role,
          members: view.members,
          // An admin sees which nodes are linked; only an owner may unlink them (the unlink route says so).
          links: view.links.map((l) => ({ id: l.id, issuer: l.issuer, services: [...l.services], createdAt: l.createdAt })),
        })
      );
    } catch (error) {
      return orgFailure(ctx, "orgs.view", error);
    }
  }
);
