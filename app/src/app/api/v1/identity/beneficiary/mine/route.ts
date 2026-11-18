// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/identity/beneficiary/mine`
 * Purpose: HUMAN plane, session only. A signed-in person lists the AIs whose earnings they accepted (GET), accepts an AI's proposal by its one-time link token (POST)
 *   and ends one (DELETE), on `/profile`.
 * Scope: HTTP validation and the session read; every write is the signed-in person's own side of the row.
 * Invariants:
 *   - BENEFICIARY_IS_ACCEPTED: only a human session accepts; the session user becomes the beneficiary. The AI stays the earner and gets no access from this.
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required`, before any read or write.
 *   - NON_DISCLOSING: a token that is wrong, used, expired, revoked or the caller's own AI answers `accepted: false`, never a reason.
 *   - FREEZE_AT_CUTOFF: ending a row never rewrites earlier cutoffs; claims already finalized keep the destination they had.
 * Side-effects: IO (service-role database)
 * Links: https://node-template.cognidao.org/knowledge/node-economic-identity
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { acceptBeneficiary, listMineBeneficiaries, revokeBeneficiary } from "@/app/_facades/identity/payout.server";
import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { reconcilePendingSettlements } from "@/bootstrap/settlement-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const acceptSchema = z.object({ token: z.string().min(1).max(200) }).strict();
const revokeSchema = z.object({ id: z.string().min(1).max(100) }).strict();

type Person = { ok: true; userId: string } | { ok: false; response: NextResponse };

async function requirePerson(request: Request, log: { warn: (f: Record<string, unknown>, m: string) => void }): Promise<Person> {
  const refused = refuseNonSession(request, log);
  if (refused) return { ok: false, response: refused };
  const user = await getSessionUser();
  if (!user || user.via !== "session") return { ok: false, response: json({ error: "unauthorized" }, 401) };
  return { ok: true, userId: user.id };
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "identity.beneficiary.mine.list", auth: { mode: "none" } },
  async (ctx, request) => {
    const person = await requirePerson(request, ctx.log);
    if (!person.ok) return person.response;
    const rows = await listMineBeneficiaries(person.userId);
    return json({ beneficiaries: rows.map((r) => ({ ...r, acceptedAt: r.acceptedAt.toISOString() })) });
  }
);

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "identity.beneficiary.mine.accept", auth: { mode: "none" } },
  async (ctx, request) => {
    const person = await requirePerson(request, ctx.log);
    if (!person.ok) return person.response;
    const parsed = acceptSchema.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    const accepted = await acceptBeneficiary(person.userId, parsed.data.token);
    if (accepted) {
      ctx.log.info({ userId: person.userId }, "[beneficiary] accepted");
      // Only claims finalized after this acceptance use it (FREEZE_AT_CUTOFF); the retry is for held claims whose cutoff it already covers.
      await reconcilePendingSettlements(ctx.log).catch((error) => ctx.log.warn({ error }, "[beneficiary] settlement reconcile failed; acceptance kept"));
    }
    return json({ accepted });
  }
);

export const DELETE = wrapRouteHandlerWithLogging(
  { routeId: "identity.beneficiary.mine.revoke", auth: { mode: "none" } },
  async (ctx, request) => {
    const person = await requirePerson(request, ctx.log);
    if (!person.ok) return person.response;
    const parsed = revokeSchema.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    return json({ revoked: await revokeBeneficiary({ beneficiaryUserId: person.userId, rowId: parsed.data.id }) });
  }
);
