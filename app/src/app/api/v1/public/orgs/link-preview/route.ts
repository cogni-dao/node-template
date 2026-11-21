// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/orgs/link-preview`
 * Purpose: The public preview of a link code (task.0181): POST `{ code }` answers the org's name and this node's origin for a code that is still valid and unused, so the other node's
 *   admin sees who they are about to act for before their node signs anything. It lives under `/api/v1/public/` because the perimeter lets only that namespace through with no session.
 * Scope: HTTP, the body and delegation to `container.orgAccounts.previewCode`. No session (the public wrapper rate limits per IP; the code is the credential and is looked up by hash).
 * Invariants:
 *   - PREVIEW_SAYS_LITTLE: `{ orgName, origin }` and nothing else. An unknown, used, expired, malformed or another node's code is ONE answer: 404 `not_found`.
 *   - CODE_IN_THE_BODY: the code is a POST body, never a query string, because every proxy on the way logs a URL.
 *   - BOUNDED: the code is at most 700 characters, one hashed lookup, no write, and every answer is `no-store`.
 *   - NO_CODE_IN_LOGS: the code is never logged.
 * Side-effects: IO (one service-role database read)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgLinkPreviewOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// wrapPublicRoute: rate limited per IP, no session. A preview is never cached.
export const POST = wrapPublicRoute(
  { routeId: "orgs.link-preview", cacheTtlSeconds: 0, staleWhileRevalidateSeconds: 0 },
  async (ctx, request) => {
    const body: unknown = await request.json().catch(() => null);
    const parsed = orgLinkPreviewOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "not_found" }, 404);
    try {
      const preview = await getContainer().orgAccounts.previewCode(parsed.data.code);
      return preview ? json(orgLinkPreviewOperation.output.parse(preview)) : json({ error: "not_found" }, 404);
    } catch (error) {
      ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "orgs.link-preview", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
