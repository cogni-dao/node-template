// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs`
 * Purpose: Register an org for an owner source (story.0038): `{ source: { kind: "repo-spec", ref } }` returns the org's user id and its one billing account id.
 * Scope: HTTP validation, the owner check and delegation to the agent authority (`ensureOrg` in `@cogni-dao/agent-grants/orgs`). Any authenticated caller, session or bearer.
 * Invariants:
 *   - REGISTRATION_GRANTS_NOTHING: the call is idempotent per source (one org per repo and path) and gives the caller no authority.
 *   - ONLY_AN_OWNER_REGISTERS: before any row is written the caller must be one of `owners(source)` (the repo-spec's `activity_ledger.approvers`, read live through the owner
 *     source). That proves the repo exists and lists approvers and bounds the writes to real orgs: a non-owner is 403 `not_an_owner`, an unreadable owner source is
 *     503 `owner_source_unavailable`, and nothing is created in either case.
 *   - A ref or path that is not canonical is 400 `invalid_source`; a store failure is 503 `authz_unavailable`.
 * Side-effects: IO (service-role database writes)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { canonicalRepoRef, InvalidOrgSourceError, OwnerSourceUnavailableError } from "@cogni/agent-grants/orgs";
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
    bearerWrite: "registers an org for a repo whose listed approver the caller is and grants no authority; it reads or changes none of the caller's data",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = ensureOrgOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    const { source } = parsed.data;
    if (!canonicalRepoRef(source.ref, source.path)) return json({ error: "invalid_source" }, 400);
    const container = getContainer();
    try {
      const owners = await container.serviceAuth.owners.owners(source);
      if (!owners.includes(sessionUser.id)) return json({ error: "not_an_owner" }, 403);
    } catch (error) {
      if (error instanceof OwnerSourceUnavailableError) {
        ctx.log.warn(
          { event: EVENT_NAMES.AGENT_ROLES_REFUSED, routeId: "orgs.ensure", reason: error.reason },
          EVENT_NAMES.AGENT_ROLES_REFUSED
        );
        return json({ error: "owner_source_unavailable" }, 503);
      }
      throw error;
    }
    try {
      const org = await container.agentAuthority.ensureOrg(source);
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
