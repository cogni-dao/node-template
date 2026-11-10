// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests`
 * Purpose: AI plane (bearer only). An agent asks for a permission for itself (POST) and lists its own asks (GET).
 *   This is the external grant path: the ask is an OFF row; an admin's click on the profile table turns it on.
 * Scope: HTTP validation, the bearer-only plane rule, and delegation to the agent authority. No authority logic.
 * Invariants:
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

import { AgentRolesError } from "@cogni/agent-grants";
import {
  agentAccessRequestCreateOperation,
  agentAccessRequestListOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.access.requests.create", auth: { mode: "required", getSessionUser } },
  async (_ctx, request, sessionUser) => {
    // AI plane: a bearer only. A browser session gets 404, as if the route did not exist for it.
    if (sessionUser.via !== "bearer") return json({ error: "not_found" }, 404);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = agentAccessRequestCreateOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input", issues: parsed.error.issues }, 400);

    try {
      const result = await getContainer().agentAuthority.requestAccess({
        principalUserId: sessionUser.id,
        scope: parsed.data.scope,
      });
      return json(
        agentAccessRequestCreateOperation.output.parse({ scope: parsed.data.scope, ...result }),
        result.created ? 201 : 200
      );
    } catch (error) {
      if (error instanceof AgentRolesError) {
        if (error.code === "invalid_scope") return json({ error: "invalid_scope" }, 400);
        if (error.code === "no_external_door") return json({ error: "no_external_door" }, 400);
        if (error.code === "too_many_requests") return json({ error: "too_many_requests" }, 429);
      }
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.access.requests.list", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, sessionUser) => {
    if (sessionUser.via !== "bearer") return json({ error: "not_found" }, 404);
    try {
      const requests = await getContainer().agentAuthority.listOwnAccess(sessionUser.id);
      return json(agentAccessRequestListOperation.output.parse({ requests }));
    } catch {
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
