// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/renew-v1`
 * Purpose: Key bridge (task.0069, child of task.5474). A valid v1 agent key mints a fresh v1 key for the SAME users.id,
 *   30-day life, expiry capped at the hard stop. No table, no new crypto: it reuses `issueAgentApiKey`.
 * Scope: Bearer-only gate, hard-stop check, wallet and internal-principal refusal, key issue. Does not touch the v1 verify path.
 * Invariants:
 *   - C1 HARD_STOP_ONLY_SHORTENS: effective hard stop = min(code default, AGENT_V1_HARD_STOP). At or after it: 403 `v1_hard_stop`.
 *   - C2 V1_BEARER_ONLY: a session (any non-bearer identity) is 403; an expired key never reaches here (the resolver gives 401);
 *     a user with a wallet or an internal agent principal is 403 `not_agent_key`.
 *   - C3 SERVICE_ADAPTER_ONLY: the route reads users and agent_principals with the service db and touches no billing account
 *     (the billing account is bound to users.id, which does not change). Any future account access uses serviceAccountService.
 *   - Never logs or stores the key.
 * Side-effects: IO (service-role db read), log `agent.credential.v1_renewed`
 * Links: https://cognidao.org/work/items/task.5474, https://cognidao.org/work/items/task.0069
 * @public
 */

import { agentPrincipals, users } from "@cogni/db-schema";
import { renewAgentCredentialsV1Operation } from "@cogni/node-contracts";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { effectiveAgentV1HardStop } from "@/app/_lib/auth/agent-v1-hard-stop";
import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env/server";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RENEW_TTL_SECONDS = 60 * 60 * 24 * 30;
const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.credentials.renew_v1",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser) => {
    const refuse = (status: number, error: string) => {
      ctx.log.warn(
        {
          event: EVENT_NAMES.AGENT_CREDENTIAL_V1_RENEW_REFUSED,
          userId: sessionUser.id,
          reason: error,
        },
        EVENT_NAMES.AGENT_CREDENTIAL_V1_RENEW_REFUSED
      );
      return json({ error }, status);
    };

    if (sessionUser.via !== "bearer") return refuse(403, "bearer_required");

    const hardStop = effectiveAgentV1HardStop(serverEnv().AGENT_V1_HARD_STOP);
    if (!hardStop) return refuse(503, "renew_disabled");
    if (hardStop.ignoredEnv) {
      ctx.log.warn(
        { event: EVENT_NAMES.AGENT_CREDENTIAL_V1_RENEW_REFUSED, reason: "env_hard_stop_ignored" },
        "AGENT_V1_HARD_STOP is later than the code default and is ignored"
      );
    }
    const nowMs = Date.now();
    if (nowMs >= hardStop.atMs) return refuse(403, "v1_hard_stop");

    const db = resolveServiceDb();
    const [user] = await db
      .select({ walletAddress: users.walletAddress })
      .from(users)
      .where(eq(users.id, sessionUser.id))
      .limit(1);
    if (!user || user.walletAddress) return refuse(403, "not_agent_key");
    const [principal] = await db
      .select({ id: agentPrincipals.id })
      .from(agentPrincipals)
      .where(eq(agentPrincipals.userId, sessionUser.id))
      .limit(1);
    if (principal) return refuse(403, "not_agent_key");

    const expMs = Math.min(nowMs + RENEW_TTL_SECONDS * 1000, hardStop.atMs);
    const apiKey = issueAgentApiKey({
      userId: sessionUser.id,
      displayName: sessionUser.displayName,
      expiresAtSec: Math.floor(expMs / 1000),
    });
    ctx.log.info(
      {
        event: EVENT_NAMES.AGENT_CREDENTIAL_V1_RENEWED,
        userId: sessionUser.id,
        newExp: new Date(expMs).toISOString(),
      },
      EVENT_NAMES.AGENT_CREDENTIAL_V1_RENEWED
    );
    return json(
      renewAgentCredentialsV1Operation.output.parse({
        userId: sessionUser.id,
        apiKey,
        expiresAt: new Date(expMs).toISOString(),
        legacy: true,
        hardStop: new Date(hardStop.atMs).toISOString(),
      })
    );
  }
);
