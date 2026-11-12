// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.service-enrollment.v1`
 * Purpose: This node's import path for the service enrollment wire contract (story.0038): the request and poll shapes of the two public routes and the
 *   enrollment token's constants and claims. The home node (the operator) pins these same names.
 * Scope: Re-export only. The zod shapes, the token claims and the result-to-HTTP mapping are fleet-carried and live in the published
 *   `@cogni-dao/agent-grants/enrollment`, so a node cannot drift from the fleet's codes. Nothing is defined here.
 * Wire: `POST /api/v1/public/agent/service-enrollments` body `{ token }` answers `{ deviceCode, expires_in, interval }`;
 *   `POST .../service-enrollments/token` body `{ deviceCode }` answers `{ sealedKey, credentialId, userId, status: "pending", pendingExpiresAt }` or 400 `{ error }`
 *   (RFC 8628: `authorization_pending` | `slow_down` | `access_denied` | `expired_token`).
 * Invariants: CONTRACTS_ARE_TRUTH, defined once in the package (`claims.ts`, `http.ts`).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

export {
  pollServiceEnrollmentOperation,
  requestServiceEnrollmentOperation,
  SERVICE_ENROLLMENT_AUDIENCE_PREFIX,
  SERVICE_ENROLLMENT_KIND,
  SERVICE_ENROLLMENT_LIMITS,
  SERVICE_ENROLLMENT_MAX_TTL_SEC,
  SERVICE_ENROLLMENT_TYP,
  type ServiceEnrollmentClaims,
  serviceEnrollmentAudience,
  serviceEnrollmentClaims,
} from "@cogni/agent-grants/enrollment";
