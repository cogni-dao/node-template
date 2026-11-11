// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment-client`
 * Purpose: Public surface of the REQUESTER half of service enrollment: a service of one node (for example operator git-review) asks another
 *   node for a revocable key. The provider half is `@cogni-dao/agent-grants/enrollment` (same protocol, same version, same wire shapes).
 * Scope: Re-exports only. Pure and storage-free: it imports `jose`, `zod` and the pure claims, seal and key-format modules of this package, never
 *   the Postgres adapters, the roles code or any database client. A consumer that has not adopted grants needs only `fetch` and `jose`.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

export { type BoundedBody, readBoundedBody, readBoundedText } from "./bounded-body";
export {
  type EnrollServiceResult,
  enrollService,
  type PollEnrollmentInput,
  type PollLoopResult,
  pollEnrollment,
  SLOW_DOWN_STEP_S,
  type StartedEnrollment,
  type StartEnrollmentInput,
  startEnrollment,
} from "./enroll";
export { generateLinkKeypair, type LinkKeypair, MAX_SEALED_KEY_CHARS, unsealServiceKey } from "./keypair";
export {
  type BuildEnrollmentClaimsInput,
  buildEnrollmentClaims,
  createEnrollmentSigner,
  type EnrollmentSigner,
  type EnrollmentSignerInput,
  type EnrollmentSigningKey,
  SERVICE_ENROLLMENT_SIGNING_ALG,
} from "./sign";
export {
  ENROLLMENT_CLIENT_LIMITS,
  ENROLLMENT_CONFIRM_PATH,
  ENROLLMENT_REQUEST_PATH,
  ENROLLMENT_TOKEN_PATH,
  type EnrollmentAccepted,
  EnrollmentClientError,
  type EnrollmentClientErrorCode,
  type EnrollmentPollResult,
  type EnrollmentTransport,
  type EnrollmentTransportOptions,
  createEnrollmentTransport,
} from "./transport";
export {
  isHttpsOrigin,
  SERVICE_ENROLLMENT_AUDIENCE_PREFIX,
  SERVICE_ENROLLMENT_KIND,
  SERVICE_ENROLLMENT_LIMITS,
  SERVICE_ENROLLMENT_MAX_TTL_SEC,
  SERVICE_ENROLLMENT_TYP,
  type ServiceEnrollmentClaims,
  type ServiceEnrollmentCnfJwk,
  serviceEnrollmentAudience,
  serviceEnrollmentClaims,
  serviceKeyOf,
} from "../claims";
