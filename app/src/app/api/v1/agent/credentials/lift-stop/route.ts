// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/lift-stop`
 * Purpose: AI plane twin of the admin's keys switch (task.0091). Lift the stop on one agent: it mints nothing and revives no key; the agent may bind or recover again.
 * Scope: Bearer auth shell, body parse and delegation to `liftPrincipalStop`, the SAME package function and the SAME node-admin check as the human door
 *   (the keys row of `/api/v1/agent-access/roles`). The human door is session only; this door is bearer only.
 * Invariants:
 *   - SAME_GATE_TWO_DOORS: the package runs `adminCheck(actor)` first: a non-admin is 403 `authz_denied`, an unavailable check 503. No AI identity passes
 *     the node-admin check yet (item I2), so today this route answers 403 to every agent.
 *   - NO_SELF_APPROVAL: it never writes `approved_by` and never touches a role row.
 *   - Terminal event: `agent.credential.stop_lifted` or `agent.credential.refused`.
 * Side-effects: IO (service-role db)
 * Links: https://cognidao.org/work/items/task.0091
 * @public
 */

import { liftPrincipalStop, liftStopOperation } from "@cogni/agent-grants/credentials";
import { NextResponse } from "next/server";

import { answerStoreOutage } from "@/app/_lib/auth/agent-credential-route";
import { answerProof, invalidInput, parseProofBody } from "@/app/_lib/auth/agent-proof-route";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAgentCredentialStore } from "@/bootstrap/agent-credentials";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "agent.credentials.lift_stop";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: ROUTE_ID, auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (sessionUser.via !== "bearer") return NextResponse.json({ error: "bearer_required" }, { status: 403, headers: { "cache-control": "no-store" } });
    const body = await parseProofBody(request, liftStopOperation.input);
    if (!body) return invalidInput();
    return answerStoreOutage(ctx, ROUTE_ID, async () => {
      const result = await liftPrincipalStop(getAgentCredentialStore(), getContainer().agentAuthority.adminCheck, {
        actorUserId: sessionUser.id,
        targetUserId: body.principalUserId,
        plane: "ai",
      });
      return answerProof(ctx, ROUTE_ID, { op: "lift", result }, {
        kind: "credential",
        ids: { actorUserId: sessionUser.id, targetUserId: body.principalUserId },
        onSuccess: () => {
          if (result.ok)
            ctx.log.info(
              { event: EVENT_NAMES.AGENT_CREDENTIAL_STOP_LIFTED, actorUserId: sessionUser.id, targetUserId: body.principalUserId, plane: "ai" },
              EVENT_NAMES.AGENT_CREDENTIAL_STOP_LIFTED
            );
        },
      });
    });
  }
);
