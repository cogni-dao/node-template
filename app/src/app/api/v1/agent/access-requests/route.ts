// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests`
 * Purpose: Authenticated self-service. An agent asks for a permission for itself (POST) and lists its own asks per account (GET).
 *   This is the external grant path: the ask is an OFF row; the approver's click (a node admin in Admin, the account owner on the profile) turns it on.
 * Scope: HTTP validation, the session origin guard, and delegation to the agent authority. No authority logic.
 * Invariants:
 *   - ASK_RETURNS_ONE_LINK: a waiting ask returns `approvalUrl`: a one-time link (24 hours, a new token on every ask) to `/profile` for an account permission
 *     or `/admin/ai-access` for a node permission, picked by the permission's declared kind. The agent hands it to the person who decides.
 *   - SESSION_POST_ORIGIN: a session POST requires the exact configured canonical origin.
 *   - SELF_REQUEST_ONLY: the caller's own user id is the principal and the requester. The body never names another agent.
 *   - NO_SELF_APPROVAL: the ask writes a row with no approver. It opens no lock. Only an admin session on the human roles
 *     route sets an approver.
 *   - The ask door is open by design: any authenticated caller may ask with no prior grant (OPEN_BY_DESIGN_ROUTES).
 *   - NODE_DECLARED_SCOPES: an undeclared scope is 400 `invalid_scope`; a scope no route an outside agent can call uses is 400
 *     `no_external_door`. Open asks are capped per agent and across the node (429).
 *   - Idempotent: asking again for a pending or live scope returns 200 with `created: false`.
 * Side-effects: IO (service-role database write and read)
 * Links: packages/agent-grants, https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import {
  accessRequestCreateHttp,
  accessRequestListHttp,
} from "@cogni/agent-grants/http";

import { httpDeps, readJsonBody, send } from "@/app/_lib/agent-access/respond";
import { getSessionUser } from "@/app/_lib/auth/session";
import { publicOrigin } from "@/app/_lib/public-origin";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env/server-env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.access.requests.create", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (sessionUser.via !== "bearer") {
      const configured = serverEnv().APP_BASE_URL;
      let canonical: string | undefined;
      try {
        canonical = configured ? new URL(configured).origin : undefined;
      } catch {
        // A missing or malformed configured origin fails closed.
      }
      if (!canonical || request.headers.get("origin") !== canonical) {
        return send({ status: 403, body: { error: "invalid_origin" }, headers: { "cache-control": "no-store" } });
      }
    }
    return send(
      await accessRequestCreateHttp(httpDeps(ctx.log), {
        via: sessionUser.via === "bearer" ? "bearer" : "session",
        principalUserId: sessionUser.id,
        body: await readJsonBody(request),
        origin: publicOrigin(request),
        authority: getContainer().agentAuthority,
      })
    );
  }
);

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.access.requests.list", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser) =>
    send(
      await accessRequestListHttp(httpDeps(ctx.log), {
        via: sessionUser.via === "bearer" ? "bearer" : "session",
        principalUserId: sessionUser.id,
        authority: getContainer().agentAuthority,
      })
    )
);
