// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment`
 * Purpose: Public surface of service enrollment: a service of another node (for example operator git-review) earns a revocable key on this
 *   node by one signed request and one admin click. A node adopts this subpath next to `./credentials`.
 * Scope: Re-exports only.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

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
  serviceEnrollmentCnfJwk,
  serviceKeyOf,
  servicePrincipalName,
} from "./claims";
export * from "./durable-provider";
export {
  durableEnrollmentHttp,
  durableEnrollmentOperation,
  durablePollHttp,
  type EnrollmentHttpInput,
  enrollmentHttp,
  pollServiceEnrollmentOperation,
  requestServiceEnrollmentOperation,
} from "./http";
export { maintenanceTick } from "./maintenance";
export {
  createPostgresEnrollmentStore,
  type PostgresEnrollmentStoreOptions,
} from "./postgres";
export * from "./protocol";
export { openSealed, SEAL_ALG, SEAL_ENC, sealToJwk } from "./seal";
export {
  DEVICE_CODE_SHAPE,
  type PollEnrollmentResult,
  pollDurableEnrollment,
  pollServiceEnrollment,
  type RequestEnrollmentResult,
  requestDurableEnrollment,
  requestServiceEnrollment,
} from "./service";
export type {
  CreateEnrollmentInput,
  CreateEnrollmentRefusal,
  CreateEnrollmentResult,
  EnrollmentStatus,
  EnrollmentStore,
  PollInput,
  PollOutcome,
} from "./types";
export {
  createEnrollmentTokenVerifier,
  type EnrollmentTokenVerifier,
  type EnrollmentVerifierOptions,
  type EnrollmentVerifyResult,
  type TrustedHome,
} from "./verify";

export { maintainEnrollmentDelivery } from "./delivery-maintenance";
