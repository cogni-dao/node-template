// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests`
 * Purpose: AI plane (bearer only). An agent asks for a permission for itself (POST) and lists its own asks per account (GET).
 *   This is the external grant path: the ask is an OFF row; the approver's click (a node admin in Admin, the account owner on the profile) turns it on.
 * Scope: HTTP validation, the bearer-only plane rule, and delegation to the agent authority. No authority logic.
 * Invariants:
 *   - ASK_RETURNS_ONE_LINK: a waiting ask returns `approvalUrl`: a one-time link (24 hours, a new token on every ask) to `/profile` for an account permission
 *     or `/admin/ai-access` for a node permission, picked by the permission's declared kind. The agent hands it to the person who decides.
 *   - KIND_PICKS_THE_PLANE: a browser session (or any identity that is not a verified bearer) gets 404, never a result.
 *   - SELF_REQUEST_ONLY: the caller's own user id is the principal and the requester. The body never names another agent.
 *   - NO_SELF_APPROVAL: the ask writes a row with no approver. It opens no lock. Only an admin session on the human roles
 *     route sets an approver.
 *   - The ask door is open by design: any authenticated bearer may ask with no prior grant (OPEN_BY_DESIGN_ROUTES).
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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.access.requests.create", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) =>
    send(
      await accessRequestCreateHttp(httpDeps(ctx.log), {
        via: sessionUser.via === "bearer" ? "bearer" : "session",
        principalUserId: sessionUser.id,
        body: await readJsonBody(request),
        origin: publicOrigin(request),
        authority: getContainer().agentAuthority,
      })
    )
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
