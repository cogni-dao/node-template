// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs`
 * Purpose: Register an org for an owner source (story.0038): `{ source: { kind: "repo-spec", ref } }` returns the org's user id and its one billing account id.
 * Scope: HTTP validation and delegation to the agent authority (`ensureOrg` in `@cogni-dao/agent-grants/orgs`). Any authenticated caller, session or bearer.
 * Invariants:
 *   - REGISTRATION_GRANTS_NOTHING: the call is idempotent per source (one org per repo) and gives the caller no authority. Who owns the org is decided later, when an owner
 *     decision is made, by reading the repo-spec's `activity_ledger.approvers` on the default branch.
 *   - A ref that is not a canonical https GitHub repo URL is 400 `invalid_source`; a store failure is 503 `authz_unavailable`.
 * Side-effects: IO (service-role database writes)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { InvalidOrgSourceError } from "@cogni/agent-grants/orgs";
import { ensureOrgOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "orgs.ensure",
    bearerWrite: "registers an org for a public repo and grants no authority; it reads or changes none of the caller's data",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = ensureOrgOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    try {
      const org = await getContainer().agentAuthority.ensureOrg(parsed.data.source);
      return json(ensureOrgOperation.output.parse({ orgUserId: org.userId, billingAccountId: org.billingAccountId }));
    } catch (error) {
      if (error instanceof InvalidOrgSourceError) return json({ error: "invalid_source" }, 400);
      ctx.log.error(
        { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "orgs.ensure", ...failureFields(error) },
        EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
      );
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
