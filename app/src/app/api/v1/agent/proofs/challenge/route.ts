// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/proofs/challenge`
 * Purpose: AI plane. An agent that holds a key asks to bind a GitHub account (task.0091, slice S1a of task.5474). The answer is a public proof line to
 *   post as a comment on an allowlisted issue, and a private `challengeSecret` only this caller receives.
 * Scope: Auth shell and delegation to `issueProofChallenge` (`@cogni-dao/agent-grants/credentials`). The bind challenge sits on the AUTHENTICATED path,
 *   never the public one (constraint C4): the challenge belongs to the caller's principal.
 * Invariants:
 *   - BEARER_ONLY: a signed key or an active revocable key. A browser session is 403 `not_agent`.
 *   - A stopped principal gets 403 `stopped`; over the per-principal limits 429; no proof issues configured 503 `proof_unavailable`.
 *   - Terminal event: `agent.proof.challenge_issued` or `agent.proof.refused`. Never logs the secret or the nonce.
 * Side-effects: IO (service-role db)
 * Links: https://cognidao.org/work/items/task.0091
 * @public
 */

import { issueProofChallenge, proofChallengeOperation } from "@cogni/agent-grants/credentials";

import { answerStoreOutage } from "@/app/_lib/auth/agent-credential-route";
import { answerProof, invalidInput } from "@/app/_lib/auth/agent-proof-route";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAgentCredentialStore, getProofConfig } from "@/bootstrap/agent-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "agent.proofs.challenge";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: ROUTE_ID, auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (sessionUser.via !== "bearer") return answerProof(ctx, ROUTE_ID, { op: "bind", result: { ok: false, reason: "not_agent" } }, { kind: "proof" });
    // The body is optional (the route implies `bind`); when present it must be exactly `{ "purpose": "bind" }`.
    const raw = (await request.text().catch(() => "")).trim();
    if (raw !== "") {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return invalidInput();
      }
      const parsed = proofChallengeOperation.input.safeParse(json);
      if (!parsed.success || parsed.data.purpose !== "bind") return invalidInput();
    }
    return answerStoreOutage(ctx, ROUTE_ID, async () => {
      const result = await issueProofChallenge(getAgentCredentialStore(), { ...getProofConfig(), purpose: "bind", principalUserId: sessionUser.id });
      return answerProof(ctx, ROUTE_ID, { op: "challenge", result }, {
        kind: "proof",
        ids: { principalUserId: sessionUser.id },
        onSuccess: () => {
          if (result.ok)
            ctx.log.info(
              { event: EVENT_NAMES.AGENT_PROOF_CHALLENGE_ISSUED, purpose: "bind", challengeId: result.challengeId, principalUserId: sessionUser.id },
              EVENT_NAMES.AGENT_PROOF_CHALLENGE_ISSUED
            );
        },
      });
    });
  }
);
