// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/agent/recover`
 * Purpose: Public. An agent with NO working key proves the GitHub account bound to its principal (task.0091) and gets ONE active key on the SAME
 *   `users.id`. Every other key of that user dies (it was lost or stolen). The `challengeSecret` is the credential, so the route needs no key.
 * Scope: Public route (`wrapPublicRoute`), body parse and delegation to `recoverCredential`. Roles stay; they belong to the user id.
 * Invariants:
 *   - FAIL_TOWARD_NO_KEY: a stopped principal is 403 `stopped` and nothing changes; GitHub down is 503 and nothing is consumed; 5 recoveries per
 *     principal per 24 hours (429 `recovery_limited`); a GitHub-only human or an unbound account is one uniform 404 `no_binding`.
 *   - The key is returned once, with `cache-control: no-store`. It is never logged.
 *   - Terminal event: `agent.credential.recovered` or `agent.proof.refused`.
 * Side-effects: IO (service-role db, GitHub read)
 * Links: https://cognidao.org/work/items/task.0091
 * @public
 */

import { type CredentialHttpInput, recoverCredential, recoverCredentialOperation } from "@cogni/agent-grants/credentials";
import { headers } from "next/headers";

import { answerStoreOutage } from "@/app/_lib/auth/agent-credential-route";
import { answerProof, invalidInput, parseProofBody } from "@/app/_lib/auth/agent-proof-route";
import { getAgentCredentialStore, getProofConfig, getProofVerifier, proofAttemptGuards, proofPublicRateLimit } from "@/bootstrap/agent-credentials";
import { wrapPublicRoute } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "agent.credentials.recover";

export const POST = wrapPublicRoute({ routeId: ROUTE_ID, ...proofPublicRateLimit }, async (ctx, request) => {
  const body = await parseProofBody(request, recoverCredentialOperation.input);
  if (!body) return invalidInput();
  return answerStoreOutage(ctx, ROUTE_ID, async () => {
    const result = await recoverCredential(getAgentCredentialStore(), getProofVerifier(), getProofConfig(), {
      ...body,
      ...proofAttemptGuards(await headers(), body.challengeId),
    });
    const input: CredentialHttpInput = { op: "recover", result };
    return answerProof(ctx, ROUTE_ID, input, {
      kind: "proof",
      ids: { challengeId: body.challengeId },
      onSuccess: () => {
        if (result.ok)
          ctx.log.info(
            { event: EVENT_NAMES.AGENT_CREDENTIAL_RECOVERED, userId: result.userId, credentialId: result.credentialId, revokedCount: result.revokedCount },
            EVENT_NAMES.AGENT_CREDENTIAL_RECOVERED
          );
      },
    });
  });
});
