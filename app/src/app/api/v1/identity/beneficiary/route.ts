// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/identity/beneficiary`
 * Purpose: AI plane (bearer only). An AI proposes that a human receive its earnings (POST), reads the state of its own proposal (GET) and withdraws it (DELETE).
 *   The human accepts signed in on `/profile` (`/api/v1/identity/beneficiary/mine`).
 * Scope: HTTP validation, the bearer-only plane rule, and delegation to the payout facade.
 * Invariants:
 *   - BENEFICIARY_IS_ACCEPTED: a proposal pays no one. Until a human accepts, the AI's claim is held. An accepted row sends the AI's earnings to the human's payout address.
 *   - EARNER_NEVER_REWRITTEN: the AI stays the earner on every receipt; only the payout destination moves.
 *   - SELF_PROPOSE_ONLY: the caller's own user id is the earner; the body names no one. The response carries a one-time link (24 hours) for the human to open on `/profile`.
 *   - KIND_PICKS_THE_PLANE: a browser session gets 404.
 *   - OWN_DATA_ONLY: declared `bearerWrite`; the only row touched is the caller's own proposal.
 * Side-effects: IO (service-role database)
 * Links: https://node-template.cognidao.org/knowledge/node-economic-identity
 * @public
 */

import { NextResponse } from "next/server";

import { beneficiaryStatus, proposeBeneficiary, revokeBeneficiary } from "@/app/_facades/identity/payout.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { publicOrigin } from "@/app/_lib/public-origin";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "identity.beneficiary.propose", bearerWrite: "proposes or withdraws only the caller's own beneficiary row; a human must accept it, and it grants no access", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (sessionUser.via !== "bearer") return json({ error: "not_found" }, 404);
    const result = await proposeBeneficiary(sessionUser.id);
    if (result.status === "accepted") return json({ status: "accepted" });
    ctx.log.info({ userId: sessionUser.id }, "[beneficiary] proposed");
    // The token rides in the fragment, so no server log or referrer sees it.
    return json(
      { status: "pending", approvalUrl: `${publicOrigin(request)}/profile#beneficiary=${result.token}`, expiresAt: result.expiresAt.toISOString() },
      201
    );
  }
);

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "identity.beneficiary.status", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, sessionUser) => {
    if (sessionUser.via !== "bearer") return json({ error: "not_found" }, 404);
    const { status, acceptedAt } = await beneficiaryStatus(sessionUser.id);
    return json({ status, acceptedAt: acceptedAt?.toISOString() ?? null });
  }
);

export const DELETE = wrapRouteHandlerWithLogging(
  { routeId: "identity.beneficiary.withdraw", bearerWrite: "proposes or withdraws only the caller's own beneficiary row; a human must accept it, and it grants no access", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, sessionUser) => {
    if (sessionUser.via !== "bearer") return json({ error: "not_found" }, 404);
    return json({ revoked: await revokeBeneficiary({ earnerUserId: sessionUser.id }) });
  }
);
