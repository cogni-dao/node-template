// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]/members/[userId]`
 * Purpose: An owner or admin changes a person's role (PATCH `{ role }`) or removes them (DELETE) (task.0181).
 * Scope: HTTP validation and delegation to `container.orgAccounts`. A person's cookie session only. Each call runs in ONE transaction that first locks the org's owner grants.
 * Invariants:
 *   - ONE_OWNER_MINIMUM: the last owner can never be removed or demoted, even by themselves or by two owners at once (409 `last_owner`).
 *   - ONLY_AN_OWNER_MAKES_AN_OWNER: an admin cannot make, demote or remove an owner (403 `not_allowed`); an admin may change or remove admins.
 *   - NON_DISCLOSING: a stranger is 404; so is a person who is not a member.
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgChangeRoleOperation, orgRemoveMemberOperation } from "@cogni/node-contracts";
import { json, orgFailure, readJson } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ orgId: string; userId: string }> };

export const PATCH = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.members.role", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId, userId } = await context.params;
    const parsed = orgChangeRoleOperation.input.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    try {
      const result = await getContainer().orgAccounts.changeRole({ actorUserId: sessionUser.id, orgUserId: orgId, targetUserId: userId, role: parsed.data.role });
      return json(orgChangeRoleOperation.output.parse(result));
    } catch (error) {
      return orgFailure(ctx, "orgs.members.role", error);
    }
  }
);

export const DELETE = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.members.remove", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId, userId } = await context.params;
    try {
      const result = await getContainer().orgAccounts.remove({ actorUserId: sessionUser.id, orgUserId: orgId, targetUserId: userId });
      return json(orgRemoveMemberOperation.output.parse(result));
    } catch (error) {
      return orgFailure(ctx, "orgs.members.remove", error);
    }
  }
);
