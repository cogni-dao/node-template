// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/identity/payout-address`
 * Purpose: HUMAN plane, session only. A signed-in person reads (GET) and sets (PUT) where their earnings are paid. Payout config is its own setting,
 *   fully separate from the wallets bound for sign-in or admin.
 * Scope: HTTP validation and the session read; the write is the caller's own row.
 * Invariants:
 *   - AUTH_IS_NOT_PAYMENT: nothing here reads or writes `user_bindings` or `users.wallet_address`; signing in with a wallet never sets this, and setting this never binds a wallet.
 *   - OWN_ROW_ONLY: the row is the session user's; the body carries only the address.
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required`. An AI's earnings reach a human through the beneficiary row, not an address of its own.
 * Side-effects: IO (service-role database)
 * Links: https://node-template.cognidao.org/knowledge/node-economic-identity
 * @public
 */

import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { z } from "zod";

import { getPayoutAddress, setPayoutAddress } from "@/app/_facades/identity/payout.server";
import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { reconcilePendingSettlements } from "@/bootstrap/settlement-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const bodySchema = z.object({ address: z.string().refine((a) => isAddress(a, { strict: false }), "not an EVM address") }).strict();

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "identity.payout-address.get", auth: { mode: "none" } },
  async (ctx, request) => {
    const refused = refuseNonSession(request, ctx.log);
    if (refused) return refused;
    const user = await getSessionUser();
    if (!user || user.via !== "session") return json({ error: "unauthorized" }, 401);
    return json({ address: await getPayoutAddress(user.id) });
  }
);

export const PUT = wrapRouteHandlerWithLogging(
  { routeId: "identity.payout-address.set", auth: { mode: "none" } },
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
    if (!parsed.success) return json({ error: "invalid_address" }, 400);
    const address = parsed.data.address.toLowerCase();
    await setPayoutAddress(user.id, address);
    ctx.log.info({ userId: user.id }, "[payout-address] set");
    // A held claim may now resolve. Reconciliation is an idempotent repair and must never undo the saved address.
    await reconcilePendingSettlements(ctx.log).catch((error) => ctx.log.warn({ error }, "[payout-address] settlement reconcile failed; address kept"));
    return json({ address });
  }
);
