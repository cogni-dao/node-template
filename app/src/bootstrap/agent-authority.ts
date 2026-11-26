// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-authority`
 * Purpose: This node's authority object: `createAgentToolAuthority` from `@cogni/agent-grants/host` (the guard store, decision log, admin check, the role, ask and mine calls, the
 *   org accounts, the payer bindings and the service-assertion ask), fed this node's tool contracts, graph catalog and identity (task.0181: nothing org-shaped lives here any more).
 * Scope: Composition only. Takes the service-role (BYPASSRLS) postgres.js client from the container: `agent_roles` and `agent_principals` are deny-all for the app role. Decides nothing itself.
 * Invariants:
 *   - ADMIN_FROM_USER_BINDINGS, DECLARED_SCOPES_FROM_CONTRACTS, NO_SECRETS_IN_LOGS, ADMINS_FROM_THE_ORG, EVERY_ACT_LOGGED: owned by the package host; see `@cogni/agent-grants/host`.
 *   - AGENT_WALLET_IS_NOT_A_PAYEE (a payout guard, not an authority rule): an agent may bind a wallet (`/api/v1/identity/wallet/bind`), so it can pass
 *     `adminCheck` when the DAO lists that wallet (AUTHORITY_IS_NOT_KIND). Claimant resolution skips agent-owned wallets and the database refuses a payout leaf for one.
 * Side-effects: IO (service-role database reads and writes)
 * Links: packages/agent-grants/src/host.ts, https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import {
  type AgentAuthoritySql,
  type AgentToolAuthority,
  createAgentToolAuthority as createHostAuthority,
} from "@cogni/agent-grants/host";
import type { OrgFacts } from "@cogni/agent-grants/org-statement";
import type { OrgOwners } from "@cogni/agent-grants/orgs";
import type { ServiceAssertionSigner } from "@cogni/agent-grants/service-auth";
import type { CatalogBoundTool } from "@cogni/ai-tools";
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import type { NodeAdminAuthority } from "@cogni/knowledge-store";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import type { Logger } from "pino";
import { failureFields } from "@/shared/observability";

export { type AgentAuthoritySql, type AgentToolAuthority, createAdminCheck, MAX_ADMIN_OUTSIDE_ROWS } from "@cogni/agent-grants/host";

export function createAgentToolAuthority(deps: {
  sql: AgentAuthoritySql;
  nodeAdmin: NodeAdminAuthority;
  log: Logger;
  toolBundle: readonly CatalogBoundTool[];
  ensureBillingAccount?: (userId: string) => Promise<string>;
  owners?: OrgOwners;
  /** This node's id: the audience of an org's connect and the `sub` of the statement this node signs. */
  nodeId?: string;
  /** This node's signer (lazy), for its own statement and its outbound connect. */
  signer?: () => Promise<ServiceAssertionSigner | null>;
  /** This node as an org: its origin and the repo-spec facts its statement carries. */
  orgIdentity?: { origin: string; version?: number | undefined; facts: () => Promise<OrgFacts> | OrgFacts };
  /** The fleet directory (origin and node id of each node): an org connects only from it, and this node connects only to it. Empty = no org connects. */
  directory?: readonly { origin: string; nodeId: string }[];
}): AgentToolAuthority {
  return createHostAuthority({
    sql: deps.sql,
    nodeAdmin: deps.nodeAdmin,
    log: deps.log,
    tools: deps.toolBundle.map((tool) => ({ id: tool.contract.name, requires: tool.contract.requires })),
    graphs: Object.values(LANGGRAPH_CATALOG),
    systemUserIds: [COGNI_SYSTEM_PRINCIPAL_USER_ID],
    ensureBillingAccount: deps.ensureBillingAccount,
    owners: deps.owners,
    nodeId: deps.nodeId,
    signer: deps.signer,
    orgIdentity: deps.orgIdentity,
    directory: deps.directory,
    failureFields,
  });
}
