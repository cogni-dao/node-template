// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/invites/[inviteId]/accept`
 * Purpose: The invited person, signed in with the invited wallet, accepts an invite: POST. Only now does the node write the grant (task.0181).
 * Scope: HTTP only. A person's cookie session only. The package checks that the invite is open, unexpired, for one of THIS person's bound wallets and that its inviter still holds the
 *   right to invite that role.
 * Invariants: INVITE_GRANTS_NOTHING until this call; single use (a second accept is 404 `invite_not_found`); an owner invite counts toward the 5-org cap (409 `too_many_orgs`).
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgAcceptInviteOperation } from "@cogni/node-contracts";
import { json, orgFailure } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ inviteId: string }> };

export const POST = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.invites.accept", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { inviteId } = await context.params;
    try {
      const accepted = await getContainer().orgAccounts.accept(sessionUser.id, inviteId);
      return json(orgAcceptInviteOperation.output.parse(accepted));
    } catch (error) {
      return orgFailure(ctx, "orgs.invites.accept", error);
    }
  }
);
