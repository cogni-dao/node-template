// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/agent/service-enrollments/token`
 * Purpose: Public. The holder of a device code polls (RFC 8628 shape). Until the admin's click: 400 `authorization_pending`. After it: a PENDING revocable
 *   key, SEALED (JWE, ECDH-ES, A256GCM) to the `cnf.jwk` of the signed enrollment token. The holder confirms it with `POST /api/v1/agent/credentials/confirm`.
 * Scope: Public route (`wrapPublicRoute`), body parse and delegation to `pollServiceEnrollment`. The device code is the credential, but alone it is not
 *   enough: it returns ciphertext that only the holder of the matching private key can open.
 * Invariants:
 *   - KEY_SEALED_TO_CNF: the key never appears in a response, a log line or a trace in the clear. A copied device code returns only ciphertext.
 *   - RFC 8628 ERRORS: 400 `authorization_pending` | `slow_down` | `access_denied` | `expired_token`.
 *   - NEVER_CACHED: every answer is `no-store` (the package's mapping, kept by wrapPublicRoute).
 *   - TERMINAL_EVENTS: `agent.enrollment.redeemed` (with `agent.credential.issued`), `.denied` or `.expired`. Routine pending and slow_down polls log only the request line.
 * Side-effects: IO (service-role db)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, https://node-template.cognidao.org/work/items/story.0038
 * @public
 */

import {
  durablePollHttp,
  enrollmentHttp,
  pollDurableEnrollment,
  pollServiceEnrollmentOperation,
} from "@cogni/agent-grants/enrollment";

import {
  answerStoreOutage,
  credentialResponse,
} from "@/app/_lib/auth/agent-credential-route";
import {
  enrollmentPublicRateLimit,
  getAgentEnrollmentStore,
} from "@/bootstrap/agent-enrollment";
import { wrapPublicRoute } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "agent.service_enrollments.token";

export const POST = wrapPublicRoute(
  { routeId: ROUTE_ID, ...enrollmentPublicRateLimit },
  async (ctx, request) => {
    const body = pollServiceEnrollmentOperation.input.safeParse(
      await request.json().catch(() => undefined)
    );
    if (!body.success)
      return credentialResponse(enrollmentHttp({ op: "invalid_input" }));
    return answerStoreOutage(ctx, ROUTE_ID, async () => {
      const result = await pollDurableEnrollment(getAgentEnrollmentStore(), {
        deviceCode: body.data.deviceCode,
      });
      if (result.ok) {
        ctx.log.info(
          {
            event: EVENT_NAMES.AGENT_ENROLLMENT_REDEEMED,
            routeId: ROUTE_ID,
            principalUserId: result.userId,
            enrollmentId: result.enrollmentId,
            credentialId: result.credentialId,
          },
          EVENT_NAMES.AGENT_ENROLLMENT_REDEEMED
        );
        ctx.log.info(
          {
            event: EVENT_NAMES.AGENT_CREDENTIAL_ISSUED,
            routeId: ROUTE_ID,
            userId: result.userId,
            credentialId: result.credentialId,
            createdFrom: "service_enrollment",
          },
          EVENT_NAMES.AGENT_CREDENTIAL_ISSUED
        );
      } else if (result.error === "access_denied") {
        ctx.log.warn(
          {
            event: EVENT_NAMES.AGENT_ENROLLMENT_DENIED,
            routeId: ROUTE_ID,
            errorCode: result.error,
          },
          EVENT_NAMES.AGENT_ENROLLMENT_DENIED
        );
      } else if (result.error === "expired_token") {
        ctx.log.warn(
          {
            event: EVENT_NAMES.AGENT_ENROLLMENT_EXPIRED,
            routeId: ROUTE_ID,
            errorCode: result.error,
          },
          EVENT_NAMES.AGENT_ENROLLMENT_EXPIRED
        );
      }
      return credentialResponse(durablePollHttp(result));
    });
  }
);
