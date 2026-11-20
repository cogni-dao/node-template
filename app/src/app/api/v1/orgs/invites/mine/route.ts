// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/invites/mine`
 * Purpose: A signed-in person lists the open invites for the wallets they signed in with (task.0181).
 * Scope: HTTP only. A person's cookie session only. The wallets come from the person's own `user_bindings`, never from the request.
 * Invariants: WALLET_REPROOF: only an invite for a wallet this person bound by signing in is listed; an invite for any other wallet is invisible.
 * Side-effects: IO (service-role database read)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgMyInvitesOperation } from "@cogni/node-contracts";
import { json, orgFailure } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "orgs.invites.mine", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, _request, sessionUser) => {
    try {
      const invites = await getContainer().orgAccounts.myInvites(sessionUser.id);
      return json(
        orgMyInvitesOperation.output.parse({
          invites: invites.map((i) => ({ id: i.id, orgUserId: i.orgUserId, orgName: i.orgName, role: i.role, expiresAt: i.expiresAt })),
        })
      );
    } catch (error) {
      return orgFailure(ctx, "orgs.invites.mine", error);
    }
  }
);
