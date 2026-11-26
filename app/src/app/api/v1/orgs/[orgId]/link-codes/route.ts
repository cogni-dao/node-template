// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]/link-codes`
 * Purpose: An org OWNER makes a one-time link code for another node's https origin: POST `{ origin }` (task.0181). That node's admin then makes the node sign the link with the code.
 * Scope: HTTP validation and delegation to `container.orgAccounts.linkCode`. A person's cookie session only.
 * Invariants:
 *   - ONLY_AN_OWNER_LINKS: an admin is 403 `not_allowed`, a stranger 404.
 *   - CODE_IS_HASHED_AND_SINGLE_USE: the code is in this answer once; only its sha256 is stored. It lives 15 minutes and is bound to this org and this origin.
 *   - An origin that is not a canonical https origin is 400 `invalid_origin`; an origin that already has an open link is 409 `issuer_already_linked`; a suspended org is 403 `org_suspended`.
 *   - NO_CODE_IN_LOGS: `org.link_code_created` carries ids and the origin, never the code.
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgLinkCodeOperation } from "@cogni/node-contracts";
import { json, orgFailure, readJson } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ orgId: string }> };

export const POST = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "orgs.link-codes.create", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { orgId } = await context.params;
    const parsed = orgLinkCodeOperation.input.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    try {
      const made = await getContainer().orgAccounts.linkCode({ actorUserId: sessionUser.id, orgUserId: orgId, origin: parsed.data.origin });
      return json(orgLinkCodeOperation.output.parse(made), 201);
    } catch (error) {
      return orgFailure(ctx, "orgs.link-codes.create", error);
    }
  }
);
