// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/agent/proofs/challenge`
 * Purpose: Public. An agent that lost its key asks to RECOVER it (task.0091). Same answer shape as the bind challenge: a public proof line and a
 *   private `challengeSecret`. The caller has no key, so the node cannot know the principal here; the stop check runs at recover time.
 * Scope: Public route (`wrapPublicRoute`), body parse and delegation to `issueProofChallenge`. Limits: 3 per client per hour (in memory, best effort),
 *   20 per hour for the whole node and at most 200 open challenges (counted in the database), so a flood only delays recovery and never grants it.
 * Invariants:
 *   - Terminal event: `agent.proof.challenge_issued` or `agent.proof.refused`. Never logs the secret, the nonce or the client address.
 *   - NEVER_CACHED: the answer is `no-store` (the package's mapping; `wrapPublicRoute` leaves an existing Cache-Control alone).
 * Side-effects: IO (service-role db through the credential store)
 * Links: https://cognidao.org/work/items/task.0091
 * @public
 */

import { issueProofChallenge, proofChallengeOperation } from "@cogni/agent-grants/credentials";
import { headers } from "next/headers";

import { answerStoreOutage } from "@/app/_lib/auth/agent-credential-route";
import { answerProof, invalidInput, parseProofBody } from "@/app/_lib/auth/agent-proof-route";
import { admitAnonymousChallenge, getAgentCredentialStore, getProofConfig } from "@/bootstrap/agent-credentials";
import { wrapPublicRoute } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "agent.proofs.challenge.public";

export const POST = wrapPublicRoute({ routeId: ROUTE_ID }, async (ctx, request) => {
  const body = await parseProofBody(request, proofChallengeOperation.input);
  if (!body || body.purpose !== "recover") return invalidInput();
  if (!admitAnonymousChallenge(await headers())) {
    return answerProof(ctx, ROUTE_ID, { op: "challenge", result: { ok: false, reason: "rate_limited" } }, { kind: "proof" });
  }
  return answerStoreOutage(ctx, ROUTE_ID, async () => {
    const result = await issueProofChallenge(getAgentCredentialStore(), { ...getProofConfig(), purpose: "recover" });
    return answerProof(ctx, ROUTE_ID, { op: "challenge", result }, {
      kind: "proof",
      onSuccess: () => {
        if (result.ok)
          ctx.log.info(
            { event: EVENT_NAMES.AGENT_PROOF_CHALLENGE_ISSUED, purpose: "recover", challengeId: result.challengeId },
            EVENT_NAMES.AGENT_PROOF_CHALLENGE_ISSUED
          );
      },
    });
  });
});
