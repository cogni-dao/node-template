// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]/suspension`
 * Purpose: This node's admin suspends an org (or resumes it): POST `{ suspended }` (task.0181). The next run billed to a suspended org is refused with `org_suspended`.
 * Scope: HTTP validation, the one admin check and delegation to `container.orgAccounts.setSuspended`. A person's cookie session only.
 * Invariants:
 *   - ONE_ADMIN_CHECK: only a node admin (`agentAuthority.adminCheck`, the caller's bound wallets against the repo-spec roster). A non-admin is 403 `authz_denied`; no configured admins 503.
 *   - The org stays an ordinary account in the node admin's account list; suspension is `suspended_at` on its principal row and nothing else. Ledger rows are kept.
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgSuspensionOperation } from "@cogni/node-contracts";
import { json, orgFailure, readJson } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ orgId: string }> };

export const POST = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.suspension", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId } = await context.params;
    const container = getContainer();
    const admin = await container.agentAuthority.adminCheck(sessionUser.id).catch(() => "unavailable" as const);
    if (admin === "unavailable") return json({ error: "authz_unavailable" }, 503);
    if (admin !== "allow") return json({ error: "authz_denied" }, 403);
    const parsed = orgSuspensionOperation.input.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    try {
      const changed = await container.orgAccounts.setSuspended({ adminUserId: sessionUser.id, orgUserId: orgId, suspended: parsed.data.suspended });
      if (!changed) return json({ error: "not_found" }, 404);
      return json(orgSuspensionOperation.output.parse({ suspended: parsed.data.suspended }));
    } catch (error) {
      return orgFailure(ctx, "orgs.suspension", error);
    }
  }
);
