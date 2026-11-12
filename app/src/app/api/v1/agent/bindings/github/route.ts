// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/bindings/github`
 * Purpose: AI plane. The agent proves it controls a GitHub account (task.0091): it posted the proof line as a public comment, and presents the private
 *   `challengeSecret` plus the comment id. The node records the account on the agent's principal (`user_bindings` + `identity_events`, one transaction).
 * Scope: Auth shell, body parse and delegation to `bindGithubIdentity`. The comment checks, limits, transaction and status codes live in
 *   `@cogni-dao/agent-grants/credentials`; the GitHub read is the verifier wired in `bootstrap/agent-credentials.ts`.
 * Invariants:
 *   - BEARER_ONLY and SAME_PRINCIPAL: the challenge must belong to the caller; another principal's bearer gets the same 401 as a wrong secret.
 *   - 201 created, 200 already_bound, 409 binding_exists or already_linked, 422 proof_failed (+ reason), 503 proof_unavailable (nothing consumed).
 *   - Terminal event: `agent.binding.created` or `agent.proof.refused`. Logs the numeric GitHub id, never the login.
 * Side-effects: IO (service-role db, GitHub read)
 * Links: https://cognidao.org/work/items/task.0091
 * @public
 */

import { bindGithubIdentity, bindGithubOperation, type CredentialHttpInput } from "@cogni/agent-grants/credentials";
import { headers } from "next/headers";

import { answerStoreOutage } from "@/app/_lib/auth/agent-credential-route";
import { answerProof, invalidInput, parseProofBody } from "@/app/_lib/auth/agent-proof-route";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAgentCredentialStore, getProofConfig, getProofVerifier, proofAttemptGuards } from "@/bootstrap/agent-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "agent.bindings.github";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: ROUTE_ID, auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (sessionUser.via !== "bearer") return answerProof(ctx, ROUTE_ID, { op: "bind", result: { ok: false, reason: "not_agent" } }, { kind: "proof" });
    const body = await parseProofBody(request, bindGithubOperation.input);
    if (!body) return invalidInput();
    return answerStoreOutage(ctx, ROUTE_ID, async () => {
      const result = await bindGithubIdentity(getAgentCredentialStore(), getProofVerifier(ctx), getProofConfig(), {
        ...body,
        principalUserId: sessionUser.id,
        ...proofAttemptGuards(await headers(), body.challengeId),
      });
      const input: CredentialHttpInput = { op: "bind", result };
      return answerProof(ctx, ROUTE_ID, input, {
        kind: "proof",
        ids: { principalUserId: sessionUser.id, challengeId: body.challengeId },
        onSuccess: () => {
          if (result.ok)
            ctx.log.info(
              { event: EVENT_NAMES.AGENT_BINDING_CREATED, userId: sessionUser.id, githubId: result.githubId, userType: result.userType, result: result.result },
              EVENT_NAMES.AGENT_BINDING_CREATED
            );
        },
      });
    });
  }
);
