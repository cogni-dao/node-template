// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/connections`
 * Purpose: This node as a PROVIDER in connect from home (story.0038, `@cogni-dao/agent-grants` 0.10.0): apply a customer node's signed connect or disconnect, list the connected orgs,
 *   Suspend or Resume one, grant one an allowance, and answer the run gate. Thin wiring: the decisions (seq order, sticky Suspend, the gate) are in the package.
 * Scope: Composition over the service-role client and the accounts adapter. No route logic, no admin check (the Admin area's mint runs first; callers hold an `AdminSession`).
 * Invariants:
 *   - ONE_RECORD_PER_ISSUER: `apply` runs in ONE transaction: the issuer's org, its record, and one payer row per service of the issuer's trusted-home entry.
 *   - ALLOWANCE_IS_ONE_LEDGER_ROW: `grantAllowance` writes one `connection_allowance` credit-ledger row through the existing accounts adapter, keyed by an idempotency reference
 *     (`<orgUserId>:<key>`), so a retry adds nothing; a unique-index race on the same reference is the same answer. The grant never reaches the customer's cap.
 *   - GATE_READS_LIVE: `assertAdmits` reads the record's standing on every call (never cached), so Disconnect, Suspend and a spent allowance refuse the very next run.
 *   - NO_TOKEN_IN_LOGS: events carry issuer, act, cap, seq and ids, never the assertion.
 * Side-effects: IO (service-role database reads and writes; the accounts adapter)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

import {
  applyConnection,
  assertConnectionAdmits,
  type ConnectionRefusal,
  type ConnectedOrgView,
  type ConnectOutcome,
  createPostgresConnectionStore,
  DEFAULT_CONNECTION_ROWS,
  MAX_CONNECTION_ROWS,
  viewOf,
} from "@cogni/agent-grants";
import type { TrustedHome, VerifiedServiceAssertion } from "@cogni/agent-grants/service-auth";
import type { Logger } from "pino";
import type { ServiceAccountService } from "@/ports";
import { EVENT_NAMES, failureFields } from "@/shared/observability";
import type { AgentAuthoritySql } from "./agent-authority";

/** The reason on the one ledger row an allowance writes. */
export const CONNECTION_ALLOWANCE_REASON = "connection_allowance";

export interface Connections {
  /** Applies a VERIFIED assertion (the connect route's). Throws only on a store failure. */
  apply(assertion: VerifiedServiceAssertion): Promise<ConnectOutcome>;
  /** Connected orgs ordered by issuer, at most `limit`; `nextAfter` is the issuer to pass as `after` for the next page, or null at the end. */
  list(input: { limit?: number | undefined; after?: string | null | undefined }): Promise<{ orgs: ConnectedOrgView[]; nextAfter: string | null }>;
  /** Suspend or Resume. False when the org user has no record. */
  setSuspended(orgUserId: string, suspended: boolean): Promise<boolean>;
  /** One ledger row on the record's billing account; null when the org user has no record. `applied` is false when `key` was already applied. */
  grantAllowance(input: { orgUserId: string; credits: number; key: string; adminUserId: string }): Promise<{ allowance: number; applied: boolean } | null>;
  /** Throws `ConnectionRefusedError` when a run billed to `billingAccountId` is refused; returns for an ordinary payer or a record that admits it. */
  assertAdmits(billingAccountId: string): Promise<void>;
}

type AccountsPort = Pick<ServiceAccountService, "creditAccount" | "findCreditLedgerEntryByReference" | "getBillingAccountById">;

const isUniqueViolation = (error: unknown): boolean => {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth += 1)
    if ((e as { code?: unknown }).code === "23505") return true;
  return false;
};

export function createConnections(deps: {
  sql: AgentAuthoritySql;
  /** The homes this deployment trusts (`.cogni/service-links.yaml`): the source of the services to bind and the optional `node_id` label. */
  trustedHomes: readonly TrustedHome[];
  accounts: AccountsPort;
  log: Logger;
}): Connections {
  const homeOf = (issuer: string): TrustedHome | undefined => deps.trustedHomes.find((home) => home.issuer === issuer);
  const store = () => createPostgresConnectionStore(deps.sql);

  return {
    async apply(assertion) {
      const home = homeOf(assertion.issuer);
      // The verifier only passes a listed issuer, so `home` is there; an empty service list would simply bind nothing.
      const outcome = await deps.sql.begin((tx) => applyConnection(createPostgresConnectionStore(tx), { assertion, services: home?.services ?? [] }));
      if (outcome.ok)
        deps.log.info(
          {
            event: EVENT_NAMES.CONNECTION_APPLIED,
            issuer: assertion.issuer,
            act: outcome.act,
            cap: outcome.record.cap,
            seq: outcome.record.seq,
            orgUserId: outcome.record.orgUserId,
          },
          EVENT_NAMES.CONNECTION_APPLIED
        );
      else deps.log.warn({ event: EVENT_NAMES.CONNECTION_REFUSED, issuer: assertion.issuer, code: outcome.code }, EVENT_NAMES.CONNECTION_REFUSED);
      return outcome;
    },

    async list({ limit, after }) {
      const bounded = Math.max(1, Math.min(MAX_CONNECTION_ROWS, Math.floor(limit ?? DEFAULT_CONNECTION_ROWS)));
      const rows = await store().list({ limit: bounded, after: after ?? null });
      const page = rows.slice(0, bounded);
      return {
        orgs: page.map((row) => {
          const home = homeOf(row.issuer);
          return { ...viewOf(row), ...(home?.nodeId ? { nodeId: home.nodeId } : {}), ...(home?.name ? { name: home.name } : {}) };
        }),
        nextAfter: rows.length > bounded ? (page[page.length - 1]?.issuer ?? null) : null,
      };
    },

    setSuspended: (orgUserId, suspended) => store().setSuspended(orgUserId, suspended),

    async grantAllowance({ orgUserId, credits, key, adminUserId }) {
      const record = await store().get(orgUserId);
      if (!record) return null;
      const reference = `${orgUserId}:${key}`;
      const balance = async (): Promise<number> => (await deps.accounts.getBillingAccountById(record.billingAccountId))?.balanceCredits ?? 0;
      const seen = await deps.accounts.findCreditLedgerEntryByReference({ billingAccountId: record.billingAccountId, reason: CONNECTION_ALLOWANCE_REASON, reference });
      if (seen) return { allowance: await balance(), applied: false };
      try {
        const { newBalance } = await deps.accounts.creditAccount({
          billingAccountId: record.billingAccountId,
          amount: credits,
          reason: CONNECTION_ALLOWANCE_REASON,
          reference,
          // A prototype comp grant: free credits from this node's admin, not a payment. The admin is on the row so every grant is audited.
          metadata: { source: "admin_grant", adminUserId, orgUserId, issuer: record.issuer },
        });
        return { allowance: newBalance, applied: true };
      } catch (error) {
        // Two requests with the same key raced: the partial unique index let exactly one through.
        if (isUniqueViolation(error)) return { allowance: await balance(), applied: false };
        deps.log.error({ event: EVENT_NAMES.CONNECTION_GRANT_FAILED, orgUserId, ...failureFields(error) }, EVENT_NAMES.CONNECTION_GRANT_FAILED);
        throw error;
      }
    },

    async assertAdmits(billingAccountId) {
      try {
        await assertConnectionAdmits(store(), billingAccountId);
      } catch (error) {
        const code = (error as { code?: ConnectionRefusal }).code;
        if (code) deps.log.warn({ event: EVENT_NAMES.CONNECTION_RUN_REFUSED, billingAccountId, code }, EVENT_NAMES.CONNECTION_RUN_REFUSED);
        throw error;
      }
    },
  };
}
