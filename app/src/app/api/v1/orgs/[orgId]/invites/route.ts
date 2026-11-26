// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]/invites`
 * Purpose: An owner or admin invites a wallet to a role on the org: POST `{ wallet, role }` (task.0181).
 * Scope: HTTP validation and delegation to `container.orgAccounts.invite`. A person's cookie session only.
 * Invariants:
 *   - INVITE_GRANTS_NOTHING: the answer is the invite's id and its 7-day expiry. The grant is written only when the invited person accepts.
 *   - Only an owner invites an owner (403 `not_allowed`); a stranger is 404; a wallet whose person already holds a role is 409 `already_member`; an org holds at most 50 open invites.
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgInviteOperation } from "@cogni/node-contracts";
import { json, orgFailure, readJson } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ orgId: string }> };

export const POST = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.invite", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId } = await context.params;
    const parsed = orgInviteOperation.input.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    try {
      const invite = await getContainer().orgAccounts.invite({ actorUserId: sessionUser.id, orgUserId: orgId, wallet: parsed.data.wallet, role: parsed.data.role });
      return json(orgInviteOperation.output.parse(invite), 201);
    } catch (error) {
      return orgFailure(ctx, "orgs.invite", error);
    }
  }
);
