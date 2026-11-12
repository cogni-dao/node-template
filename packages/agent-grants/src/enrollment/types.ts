// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment` types
 * Purpose: Boundary types and the store port of a service enrollment.
 * Scope: Types only. The store sees the sha256 of a device code and of a key, never the code or the key.
 * Invariants:
 *   - Identities cross the boundary as plain strings (`users.id`, `agent_credentials.id`).
 *   - STATE_IS_THE_STORES: the status of an enrollment and the clock it uses live in the store (the DATABASE clock decides expiry and the poll interval).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import type { CredentialPolicy } from "../credentials/types";
import type {
  ServiceEnrollmentClaims,
  ServiceEnrollmentCnfJwk,
} from "./claims";

export type EnrollmentStatus = "open" | "redeemed" | "denied" | "expired";

export type CreateEnrollmentRefusal = "invalid_token" | "replayed_token" | "too_many_enrollments" | "too_many_agents" | "node_full";

export interface CreateEnrollmentInput {
  readonly claims: ServiceEnrollmentClaims;
  /** The one permission asked for (already checked askable by the service). */
  readonly scope: string;
  /** `git-review@cognidao.org`, built from verified claims. */
  readonly principalName: string;
  /** `<issuer origin>#<service>`. */
  readonly serviceKey: string;
  readonly deviceCodeHash: string;
  readonly limits: {
    readonly deviceCodeSec: number;
    readonly openEnrollments: number;
    readonly enrolledAgents: number;
  };
}

export type CreateEnrollmentResult =
  | {
      readonly ok: true;
      readonly principalUserId: string;
      readonly enrollmentId: string;
      /** True when the principal is new; false when an earlier enrollment of the same (issuer, service) is reused. */
      readonly principalCreated: boolean;
    }
  | { readonly ok: false; readonly reason: CreateEnrollmentRefusal };

export interface PollInput {
  readonly deviceCodeHash: string;
  /** The sha256 of the key the service made for this poll. It is stored only when the poll issues the key. */
  readonly tokenHash: string;
  readonly policy: CredentialPolicy;
  readonly intervalSec: number;
}

export type PollOutcome =
  | {
      readonly state: "issued";
      readonly enrollmentId: string;
      readonly credentialId: string;
      readonly userId: string;
      readonly pendingExpiresAt: string;
      readonly cnfJwk: ServiceEnrollmentCnfJwk;
    }
  | {
      readonly state:
        | "authorization_pending"
        | "slow_down"
        | "access_denied"
        | "expired_token";
    };

/** Persistence port. Every method is one atomic unit. Expiry and ordering use the database clock. */
export interface EnrollmentStore {
  acceptProof?: import("./durable-provider").DurableProviderStore["acceptProof"];
  pollStable?: import("./durable-provider").DurableProviderStore["pollStable"];
  /**
   * One transaction: refuses a reused `jti`, expires lapsed enrollments, applies the caps, creates the principal (or reuses the one for this
   * `serviceKey`, retaining consent and expiring only its older open enrollments), reuses or writes ONE pending ask for
   * the scope and inserts the enrollment with the hash of its device code.
   */
  createEnrollment(
    input: CreateEnrollmentInput
  ): Promise<CreateEnrollmentResult>;
  /**
   * One transaction, row-locked on the enrollment: `expired_token` for an unknown, redeemed, expired or lapsed code; `access_denied` for a
   * dismissed or switched-off ask; `slow_down` inside the interval; `authorization_pending` while the ask waits; once the admin said yes,
   * a PENDING key (`created_from = service_enrollment`) that replaces any earlier pending key of this enrollment. A code whose key is already
   * confirmed is `expired_token`.
   */
  poll(input: PollInput): Promise<PollOutcome>;
}
