// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/_lib/org-http`
 * Purpose: The one place the org routes turn a domain refusal into an HTTP answer, and read a JSON body.
 * Scope: HTTP only. No decisions: the codes come from `OrgError` and `LinkError` in `@cogni-dao/agent-grants`.
 * Invariants:
 *   - NON_DISCLOSING: a caller with no role on an org and an unknown org are both 404 `not_found`.
 *   - A store failure is 503 `authz_unavailable` with its failure class logged and no message; a refusal is never a 500.
 * Side-effects: logs `org.refused` / `agent_roles.unavailable`
 * @internal
 */

import { LinkError, OrgError } from "@cogni/agent-grants";
import { OwnerSourceUnavailableError } from "@cogni/agent-grants/orgs";
import { pageQuerySchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import type { RequestContext } from "@/shared/observability";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const NO_STORE = { "cache-control": "no-store" } as const;
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const ORG_STATUS: Record<OrgError["code"], number> = {
  not_found: 404,
  not_allowed: 403,
  last_owner: 409,
  org_role_limit: 409,
  too_many_invites: 429,
  already_member: 409,
  invalid_name: 400,
  invalid_wallet: 400,
  invalid_role: 400,
  invite_not_found: 404,
  invite_void: 409,
  invalid_cursor: 400,
};

const LINK_STATUS: Record<LinkError["code"], number> = {
  invalid_origin: 400,
  org_suspended: 403,
  issuer_already_linked: 409,
  too_many_codes: 429,
  link_not_found: 404,
};

/** The answer for a failed org action: a known refusal keeps its code and status, anything else is a logged 503. */
export function orgFailure(ctx: Pick<RequestContext, "log">, routeId: string, error: unknown): NextResponse {
  if (error instanceof OrgError) {
    ctx.log.info({ event: EVENT_NAMES.ORG_REFUSED, routeId, code: error.code }, EVENT_NAMES.ORG_REFUSED);
    return json({ error: error.code }, ORG_STATUS[error.code]);
  }
  if (error instanceof LinkError) {
    ctx.log.info({ event: EVENT_NAMES.ORG_REFUSED, routeId, code: error.code }, EVENT_NAMES.ORG_REFUSED);
    return json({ error: error.code }, LINK_STATUS[error.code]);
  }
  // A unique index that refused a racing second writer is a conflict, never an outage.
  if ((error as { code?: unknown } | null)?.code === "23505") {
    ctx.log.info({ event: EVENT_NAMES.ORG_REFUSED, routeId, code: "conflict" }, EVENT_NAMES.ORG_REFUSED);
    return json({ error: "conflict" }, 409);
  }
  ctx.log.error(
    {
      event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE,
      routeId,
      ...(error instanceof OwnerSourceUnavailableError ? { reason: error.reason } : {}),
      ...failureFields(error),
    },
    EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
  );
  return json({ error: "authz_unavailable" }, 503);
}

/** The `?limit=&cursor=` of a list route, or null when they are not valid (the route answers 400). A page is at most 100 rows. */
export function pageQuery(request: Request): { limit?: number; cursor?: string } | null {
  const url = new URL(request.url);
  const parsed = pageQuerySchema.safeParse({ limit: url.searchParams.get("limit") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined });
  if (!parsed.success) return null;
  return { ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}), ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}) };
}

/** The parsed JSON body, or null when it is not JSON. */
export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
