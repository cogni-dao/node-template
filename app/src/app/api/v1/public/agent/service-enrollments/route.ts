// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/agent/service-enrollments`
 * Purpose: Public. A trusted home node (for example the operator's git-review) posts a SIGNED enrollment token. This node verifies it, makes (or reuses)
 *   the service's principal, files ONE pending ask for the permission the token names and returns a device code. No key exists until an admin says yes
 *   and the holder polls `.../token`.
 * Scope: Public route (`wrapPublicRoute`), body parse and delegation to `requestServiceEnrollment`. The token is the credential, so the route needs no key.
 * Invariants:
 *   - TOKEN_ONCE: a `jti` is accepted once; a second POST is 401 `replayed_token` and creates nothing.
 *   - OWN_TYP_AND_KIND / TRUSTED_HOMES_ONLY / FAIL_CLOSED: see `@cogni-dao/agent-grants/enrollment` (verify.ts). A JWKS outage is 503, never an accept.
 *   - NO_SELF_APPROVAL: the request writes a pending ask. Only an admin session on /profile turns it on.
 *   - NEVER_CACHED: the answer is `no-store` (the package's mapping).
 *   - ONE_TERMINAL_EVENT: `agent.enrollment.requested`, `.replayed`, `.attestation_rejected` or `.denied`. None carries the token, the device code or a key.
 * Side-effects: IO (service-role db, the issuer's JWKS, billing account through the service adapter)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, https://node-template.cognidao.org/work/items/story.0038
 * @public
 */

import { CredentialStoreUnavailableError } from "@cogni/agent-grants/credentials";
import {
  enrollmentHttp,
  requestServiceEnrollment,
  requestServiceEnrollmentOperation,
  servicePrincipalName,
} from "@cogni/agent-grants/enrollment";

import { answerStoreOutage, credentialResponse } from "@/app/_lib/auth/agent-credential-route";
import { getEnrollmentTokenVerifier } from "@/app/_lib/auth/service-enrollment-verifier";
import {
  ensureEnrollmentBillingAccount,
  enrollmentPublicRateLimit,
  getAgentEnrollmentStore,
  getAskableScopes,
} from "@/bootstrap/agent-enrollment";
import { wrapPublicRoute } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "agent.service_enrollments.create";

export const POST = wrapPublicRoute({ routeId: ROUTE_ID, ...enrollmentPublicRateLimit }, async (ctx, request) => {
  const body = requestServiceEnrollmentOperation.input.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return credentialResponse(enrollmentHttp({ op: "invalid_input" }));
  return answerStoreOutage(ctx, ROUTE_ID, async () => {
    const result = await requestServiceEnrollment(getAgentEnrollmentStore(), getEnrollmentTokenVerifier(), {
      token: body.data.token,
      askableScopes: getAskableScopes(),
    });
    if (result.ok) {
      try {
        await ensureEnrollmentBillingAccount(result.principalUserId, servicePrincipalName(result.issuer, result.service));
      } catch (cause) {
        throw new CredentialStoreUnavailableError(cause);
      }
      ctx.log.info(
        {
          event: EVENT_NAMES.AGENT_ENROLLMENT_REQUESTED,
          routeId: ROUTE_ID,
          principalUserId: result.principalUserId,
          enrollmentId: result.enrollmentId,
          service: result.service,
          issuerHost: new URL(result.issuer).host,
          scope: result.scope,
          principalCreated: result.principalCreated,
        },
        EVENT_NAMES.AGENT_ENROLLMENT_REQUESTED
      );
    } else if (result.reason === "replayed_token") {
      ctx.log.warn({ event: EVENT_NAMES.AGENT_ENROLLMENT_REPLAYED, routeId: ROUTE_ID }, EVENT_NAMES.AGENT_ENROLLMENT_REPLAYED);
    } else if (result.reason === "invalid_token" || result.reason === "jwks_unavailable") {
      ctx.log.warn(
        { event: EVENT_NAMES.AGENT_ENROLLMENT_ATTESTATION_REJECTED, routeId: ROUTE_ID, reason: result.reason },
        EVENT_NAMES.AGENT_ENROLLMENT_ATTESTATION_REJECTED
      );
    } else {
      ctx.log.warn(
        { event: EVENT_NAMES.AGENT_ENROLLMENT_DENIED, routeId: ROUTE_ID, errorCode: result.reason },
        EVENT_NAMES.AGENT_ENROLLMENT_DENIED
      );
    }
    return credentialResponse(enrollmentHttp({ op: "request", result }));
  });
});
