// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests/preview`
 * Purpose: The signed-in account owner previews a pending agent access request
 *   selected by its one-time approval token.
 * Scope: Thin route — human browser session only (any Authorization header is
 *   refused; same-origin enforced), body parse, delegate, response.
 * Invariants:
 *   - TOKEN_NEVER_IN_URL: the token travels only in the JSON body, so no
 *     path-logging layer (proxy perimeter log, ingress) can capture it. Never
 *     logged.
 *   - NON_DISCLOSING_DENIAL: unknown, used, or expired tokens are one 404.
 * Links: story.5115, packages/agent-grants
 * @public
 */

import { previewAccessRequest } from "@cogni-dao/agent-grants";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  notFoundResponse,
  withPrincipalTx,
} from "@/app/_lib/agent-grants/node-agent-grants";
import { resolveHumanSessionIdentity } from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ token: z.string().min(16).max(256) });

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.access_requests.preview",
    auth: { mode: "required", getSessionUser: resolveHumanSessionIdentity },
  },
  async (_ctx, request, sessionUser) => {
    if (!sessionUser) return notFoundResponse();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const preview = await withPrincipalTx(sessionUser.id, (tx) =>
      previewAccessRequest(tx, { token: parsed.data.token })
    );
    if (!preview) return notFoundResponse();
    return NextResponse.json({
      id: preview.id,
      requesterDisplayName: preview.requesterDisplayName,
      requestedScopes: preview.requestedScopes,
      grantExpiresAt: preview.grantExpiresAt.toISOString(),
    });
  }
);
