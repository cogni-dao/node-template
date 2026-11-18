// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/identity/beneficiary/mine/preview`
 * Purpose: HUMAN plane, session only, read-only. Before accepting, the person sees which AI account a link token names.
 * Scope: HTTP validation and the session read. Writes nothing.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required`.
 *   - TOKEN_IS_A_BEARER_CAPABILITY: the token (in the body, never a URL) is the only thing that selects a proposal; it names nothing but the AI's display name.
 *   - NON_DISCLOSING: a wrong, used, expired, revoked or own-AI token all answer `valid: false`, never a reason.
 * Side-effects: IO (service-role database read)
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { previewBeneficiary } from "@/app/_facades/identity/payout.server";
import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const bodySchema = z.object({ token: z.string().min(1).max(200) }).strict();

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "identity.beneficiary.mine.preview", auth: { mode: "none" } },
  async (ctx, request) => {
    const refused = refuseNonSession(request, ctx.log);
    if (refused) return refused;
    const user = await getSessionUser();
    if (!user || user.via !== "session") return json({ error: "unauthorized" }, 401);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    const preview = await previewBeneficiary(user.id, parsed.data.token);
    return json(preview ? { valid: true, earnerName: preview.earnerName } : { valid: false });
  }
);
