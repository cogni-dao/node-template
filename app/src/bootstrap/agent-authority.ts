// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-authority`
 * Purpose: This node's authority object: `createAgentToolAuthority` from `@cogni/agent-grants/host` (the guard store, decision log, admin check, and the role, ask
 *   and mine calls) plus this node's org, service-assertion and payer methods, which join the package after task.0181 (agent-grants 0.10.0).
 * Scope: Composition only. Takes the service-role (BYPASSRLS) postgres.js client from the container: `agent_roles` and `agent_principals` are deny-all for the app
 *   role. Decides nothing itself (ONE_AUTHORIZE_FN lives in the package).
 * Invariants:
 *   - ADMIN_FROM_USER_BINDINGS, DECLARED_SCOPES_FROM_CONTRACTS, NO_SECRETS_IN_LOGS: owned by the package host; see `@cogni/agent-grants/host`.
 *   - AGENT_WALLET_IS_NOT_A_PAYEE (a payout guard, not an authority rule): an agent may bind a wallet (`/api/v1/identity/wallet/bind`), so it can pass
 *     `adminCheck` when the DAO lists that wallet (AUTHORITY_IS_NOT_KIND). Claimant resolution skips agent-owned wallets and the database refuses a payout leaf for one.
 * Side-effects: IO (service-role database reads and writes)
 * Links: packages/agent-grants/src/host.ts, https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import {
  type AskOutcome,
  createPostgresAgentGrantsStore,
  createPostgresPayerBindingStore,
  decidePayerBinding,
  ownersForBinding,
  payerFor,
  requestPayerBinding,
  revokePayerBinding,
} from "@cogni/agent-grants";
import {
  type AgentAuthoritySql,
  type AgentToolAuthority as HostAgentToolAuthority,
  createAgentToolAuthority as createHostAuthority,
  AGENT_HOST_EVENTS,
} from "@cogni/agent-grants/host";
import { canonicalRepoRef, ensureOrg, type OrgOwners, type OrgSource } from "@cogni/agent-grants/orgs";
import {
  findServicePrincipal,
  requestServiceAccess,
  type VerifiedServiceAssertion,
} from "@cogni/agent-grants/service-auth";
import type { CatalogBoundTool } from "@cogni/ai-tools";
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import type { NodeAdminAuthority } from "@cogni/knowledge-store";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import type { Logger } from "pino";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export { type AgentAuthoritySql, createAdminCheck, MAX_ADMIN_OUTSIDE_ROWS } from "@cogni/agent-grants/host";

export interface AgentToolAuthority extends HostAgentToolAuthority {
  /**
   * PAYER_IS_AUTHORIZED: a subject (any principal) asks to be billed to `billingAccountId`. Grants nothing. Throws AgentRolesError (`principal_not_found`,
   * `not_allowed` when a live binding must be turned Off first, `too_many_requests`).
   */
  requestPayerBinding(subjectUserId: string, billingAccountId: string): Promise<{ id: string; state: "pending" | "live"; created: boolean }>;
  /** An owner of the account (an org's owners through the owner source) turns a pending binding On (`approve`) or dismisses it. */
  decidePayerBinding(me: Parameters<HostAgentToolAuthority["turnMineOn"]>[0], id: string, approve: boolean): Promise<{ changed: boolean }>;
  /** An owner of the account turns a binding Off. The subject's next run falls back to its own account. */
  revokePayerBinding(me: Parameters<HostAgentToolAuthority["turnMineOn"]>[0], id: string): Promise<{ changed: boolean }>;
  /** The account a live binding names for this subject, or null. Read on every call, never cached, so Off refuses the next run. */
  payerFor(subjectUserId: string): Promise<string | null>;
  /** The org for a source, created if absent: its own users row and one ordinary billing account. */
  ensureOrg(source: OrgSource): Promise<{ userId: string; billingAccountId: string }>;
  /** The principal user id a verified service assertion maps to, or null when it never asked. */
  servicePrincipalOf(assertion: Pick<VerifiedServiceAssertion, "issuer" | "service">): Promise<string | null>;
  /** A verified service asks for a scope for itself: one pending ask on its own principal. */
  requestServiceAccess(assertion: VerifiedServiceAssertion, scope: string): Promise<AskOutcome>;
}

export function createAgentToolAuthority(deps: {
  sql: AgentAuthoritySql;
  nodeAdmin: NodeAdminAuthority;
  log: Logger;
  toolBundle: readonly CatalogBoundTool[];
  ensureBillingAccount?: (userId: string) => Promise<string>;
  owners?: OrgOwners;
}): AgentToolAuthority {
  const host = createHostAuthority({
    sql: deps.sql,
    nodeAdmin: deps.nodeAdmin,
    log: deps.log,
    tools: deps.toolBundle.map((tool) => ({ id: tool.contract.name, requires: tool.contract.requires })),
    graphs: Object.values(LANGGRAPH_CATALOG),
    systemUserIds: [COGNI_SYSTEM_PRINCIPAL_USER_ID],
    ensureBillingAccount: deps.ensureBillingAccount,
    owners: deps.owners,
    failureFields,
  });
  const { declaredScopes, askableScopes, scopeKinds } = host;

  return {
    ...host,
    async requestPayerBinding(subjectUserId, billingAccountId) {
      const outcome = await deps.sql.begin((tx) =>
        requestPayerBinding(createPostgresPayerBindingStore(tx), { subjectUserId, billingAccountId })
      );
      return { id: outcome.id, state: outcome.state, created: outcome.created };
    },
    async decidePayerBinding(me, id, approve) {
      // OWNERS_READ_BEFORE_THE_TRANSACTION: the org's owners (a GitHub read) are read before `begin`, so no database connection waits on it.
      const owners = await ownersForBinding(
        createPostgresPayerBindingStore(deps.sql),
        createPostgresAgentGrantsStore(deps.sql),
        deps.owners,
        id
      );
      const result = await deps.sql.begin((tx) =>
        decidePayerBinding(createPostgresPayerBindingStore(tx), createPostgresAgentGrantsStore(tx), { me, id, approve, owners })
      );
      if (result.decided)
        deps.log.info(
          {
            event: approve ? EVENT_NAMES.PAYER_BOUND : EVENT_NAMES.PAYER_REVOKED,
            subject: result.subjectUserId,
            billingAccountId: result.billingAccountId,
            ...(approve ? { approvedBy: me.userId } : { revokedBy: me.userId }),
          },
          approve ? EVENT_NAMES.PAYER_BOUND : EVENT_NAMES.PAYER_REVOKED
        );
      return { changed: result.decided };
    },
    async revokePayerBinding(me, id) {
      const owners = await ownersForBinding(
        createPostgresPayerBindingStore(deps.sql),
        createPostgresAgentGrantsStore(deps.sql),
        deps.owners,
        id
      );
      const result = await deps.sql.begin((tx) =>
        revokePayerBinding(createPostgresPayerBindingStore(tx), createPostgresAgentGrantsStore(tx), { me, id, owners })
      );
      if (result.revoked)
        deps.log.info(
          { event: EVENT_NAMES.PAYER_REVOKED, subject: result.subjectUserId, billingAccountId: result.billingAccountId, revokedBy: me.userId },
          EVENT_NAMES.PAYER_REVOKED
        );
      return { changed: result.revoked };
    },
    payerFor: (subjectUserId) => payerFor(createPostgresPayerBindingStore(deps.sql), subjectUserId),
    async ensureOrg(source) {
      const org = await deps.sql.begin((tx) => ensureOrg(tx, source));
      deps.log.info(
        { event: EVENT_NAMES.ORG_ENSURED, orgUserId: org.userId, sourceRef: canonicalRepoRef(source.ref, source.path) ?? source.ref },
        EVENT_NAMES.ORG_ENSURED
      );
      return org;
    },
    servicePrincipalOf: (assertion) => findServicePrincipal(deps.sql, assertion),
    async requestServiceAccess(assertion, scope) {
      const { userId, outcome } = await deps.sql.begin((tx) =>
        requestServiceAccess({
          tx,
          store: createPostgresAgentGrantsStore(tx),
          assertion,
          scope,
          declaredScopes,
          askableScopes,
          scopeKinds,
        })
      );
      if (outcome.created)
        deps.log.info(
          {
            event: AGENT_HOST_EVENTS.roleRequested,
            principalUserId: userId,
            scope,
            resource: scopeKinds[scope] === "account" ? "account" : "node",
          },
          AGENT_HOST_EVENTS.roleRequested
        );
      return outcome;
    },
  };
}
