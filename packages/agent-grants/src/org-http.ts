// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/http` (org routes)
 * Purpose: The fleet's ONE route core and wire contracts for org accounts (task.0181): "Your orgs", the org account page, grant and remove `org:spend`, the org's server-to-server
 *   connect and disconnect, the org's own list of connections, and the node-admin suspend and restore. A node's Next route files call these and keep only auth, the response
 *   object and the one call. Re-exported from `./http`.
 * Scope: Framework-free; returns `{ status, body, headers }`, builds no `Response`, logs nothing itself (the node's `onUnavailable` logs). Who the caller is stays with the node.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: every 2xx body is parsed through its zod shape here.
 *   - NON_DISCLOSING: an org the caller holds no role on is one 404 `not_found`, whether it exists or not.
 *   - ADMINS_FROM_THE_ORG: only a caller the org's statement names may grant or remove `org:spend` (one non-disclosing 404 otherwise; an unreadable statement is 503 `statement_unavailable`).
 *   - CONNECT_IS_SERVER_TO_SERVER: connect and disconnect take a verified service assertion whose issuer is the org's origin; a refusal is one 401 `unauthorized` (503 when the keys are unreachable).
 *   - SUSPEND_NEEDS_A_REASON: suspend and restore without a reason are 400 `invalid_reason`.
 *   - STORE_OUTAGE_IS_503: a store failure is 503 `authz_unavailable`, reported once through `onUnavailable`. NEVER_CACHED: every response is `no-store`.
 * Side-effects: none beyond the injected calls
 * Links: ./org-accounts.ts, https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { z } from "zod";

import {
  type AdminOrgRow,
  ORG_CONNECT_SERVICE,
  OrgAccountError,
  type MyOrgRow,
  type OrgAccountView,
  type ConnectResult,
} from "./org-accounts";
import { OwnerSourceUnavailableError } from "./orgs";
import type { ServiceAssertionResult } from "./service-auth";
import type { AgentHttpDeps, AgentHttpResponse } from "./http";

const NO_STORE = { "cache-control": "no-store" } as const;

const respond = (body: unknown, status = 200): AgentHttpResponse => ({ status, body, headers: NO_STORE });
const notFound = (): AgentHttpResponse => respond({ error: "not_found" }, 404);

const status = z.enum(["connected", "disconnected", "suspended"]);
const role = z.enum(["admin", "spend"]);
const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const orgsMineOperation = {
  id: "orgs.mine.v1",
  output: z.object({
    orgs: z.array(z.object({ orgUserId: z.string(), billingAccountId: z.string(), name: z.string(), role, balance: z.number(), status })),
    /** The cursor of the next page (an origin, pass back as `?after=`), or null on the last page. */
    next: z.string().nullable(),
  }),
} as const;

export const orgViewOperation = {
  id: "orgs.view.v1",
  output: z.object({
    org: z.object({
      orgUserId: z.string(),
      name: z.string(),
      role,
      status,
      suspendReason: z.string().nullable(),
      balance: z.number(),
      /** In the single-org view, present only for an `org:admin` viewer (the one role that may fund the org); the org list carries it for every role, for Bill to. */
      billingAccountId: z.string().optional(),
      canManage: z.boolean(),
      adminLapsed: z.boolean(),
      people: z.array(
        z.object({ who: z.string(), kind: z.enum(["person", "service"]), role: z.enum(["admin", "spend", "service"]), held: z.boolean(), removable: z.boolean() })
      ),
      peopleNext: z.string().nullable(),
      history: z.array(z.object({ act: z.string(), actor: z.string(), reason: z.string().nullable(), at: z.string() })),
      historyNext: z.string().nullable(),
    }),
  }),
} as const;

export const orgSpendOperation = {
  id: "orgs.spend.v1",
  /** POST grants `org:spend` to a wallet; DELETE takes it away. The org comes from the path, the approver from the session. */
  input: z.object({ wallet }),
  output: z.object({ changed: z.boolean(), held: z.boolean() }),
} as const;

/** Both connect and disconnect answer with the account's status, so the org's governance page shows it. */
export const orgConnectOperation = {
  id: "orgs.connect.v1",
  /** `applied`: the statement was recorded (false = it was older than the one held). `version`: the statement version this node now holds for the org, which the org records as acknowledged only when it is at least its own. */
  output: z.object({ status, reason: z.string().nullable(), applied: z.boolean(), version: z.number().int().nullable() }),
} as const;

export const orgConnectionsOperation = {
  id: "orgs.connections.v1",
  /** POST connects to the node at `origin` (the org's own admin enters it). DELETE disconnects. */
  input: z.object({ origin: z.string().min(1).max(200) }),
  list: z.object({
    connections: z.array(z.object({ origin: z.string(), name: z.string(), status: status.or(z.literal("unreachable")), reason: z.string().nullable() })),
    next: z.string().nullable(),
  }),
  output: z.object({ origin: z.string(), status: status.or(z.literal("unreachable")), reason: z.string().nullable() }),
} as const;

export const adminOrgsOperation = {
  id: "admin.orgs.v1",
  /** One page by origin; `next` is the cursor for `?after=` (null on the last page). */
  list: z.object({ orgs: z.array(z.object({ orgUserId: z.string(), name: z.string(), status, reason: z.string().nullable() })), next: z.string().nullable() }),
  /** `suspend: true` suspends, `false` restores. A reason is required either way. */
  input: z.object({ suspend: z.boolean(), reason: z.string().min(1).max(500) }),
  output: z.object({ orgUserId: z.string(), status }),
} as const;

/** The scope claims the org's signed calls carry. */
export const ORG_CONNECT_SCOPE = "org:connect";
export const ORG_DISCONNECT_SCOPE = "org:disconnect";
/** The one service slug an org's connect call is signed as. */
export { ORG_CONNECT_SERVICE };

/** What the org route cores read of a node's authority object. */
export interface OrgAuthority {
  listMyOrgs(userId: string, after?: string | null): Promise<{ orgs: MyOrgRow[]; next: string | null }>;
  orgView(userId: string, orgUserId: string, page?: { historyBefore?: string | null; peopleAfter?: string | null }): Promise<OrgAccountView | null>;
  /** Throws `OrgAccountError` `not_allowed` or `not_found` (the route answers both with the one 404) unless the caller is an admin of the org by its statement; `OwnerSourceUnavailableError` (503) when the statement cannot be read. */
  grantSpend(me: { userId: string }, orgUserId: string, wallet: string): Promise<{ changed: boolean; held: boolean }>;
  removeSpend(me: { userId: string }, orgUserId: string, wallet: string): Promise<{ changed: boolean }>;
  /** The org node's connect: pull and verify the statement at `origin`, create or refresh the account. */
  connectOrg(origin: string): Promise<ConnectResult>;
  disconnectOrg(origin: string): Promise<ConnectResult | null>;
  adminOrgs(after?: string | null): Promise<{ orgs: AdminOrgRow[]; next: string | null }>;
  /** The node-admin session decided; `by` is its user id. */
  setSuspension(input: { by: string; orgUserId: string; suspend: boolean; reason: string }): Promise<{ status: "connected" | "disconnected" | "suspended" }>;
}

/** The org's own list of the nodes it connected to, and the two actions. The node's admin session is already checked; `by` is that admin's user id (every write names its actor). */
export interface OrgConnectionsAuthority {
  list(after?: string | null): Promise<{ connections: Array<{ origin: string; name: string; status: "connected" | "disconnected" | "suspended" | "unreachable"; reason: string | null }>; next: string | null }>;
  connect(origin: string, by: string): Promise<{ origin: string; status: "connected" | "disconnected" | "suspended" | "unreachable"; reason: string | null }>;
  disconnect(origin: string, by: string): Promise<{ origin: string; status: "connected" | "disconnected" | "suspended" | "unreachable"; reason: string | null }>;
}

const unavailable = (deps: AgentHttpDeps, routeId: string, error: unknown): AgentHttpResponse => {
  deps.onUnavailable(routeId, error);
  return respond({ error: "authz_unavailable" }, 503);
};

const statementDown = (): AgentHttpResponse => respond({ error: "statement_unavailable" }, 503);

/** `GET /api/v1/orgs`: the org accounts the signed-in person holds a role on ("Your orgs" and the composer's Bill to). */
export async function orgsMineHttp(deps: AgentHttpDeps, input: { userId: string; after?: string | null; authority: Pick<OrgAuthority, "listMyOrgs"> }): Promise<AgentHttpResponse> {
  try {
    return respond(orgsMineOperation.output.parse(await input.authority.listMyOrgs(input.userId, input.after ?? null)));
  } catch (error) {
    return unavailable(deps, "orgs.mine", error);
  }
}

/** `GET /api/v1/orgs/{orgId}`: one org account page. A person with no role gets the one 404. */
export async function orgViewHttp(
  deps: AgentHttpDeps,
  input: { userId: string; orgUserId: string; /** The raw `historyBefore` and `peopleAfter` query values (More on the history and on the people). */ query?: { historyBefore: string | null; peopleAfter: string | null }; authority: Pick<OrgAuthority, "orgView"> }
): Promise<AgentHttpResponse> {
  try {
    const after = input.query?.peopleAfter ?? null;
    const org = await input.authority.orgView(input.userId, input.orgUserId, {
      historyBefore: input.query?.historyBefore ?? null,
      peopleAfter: after,
    });
    return org ? respond(orgViewOperation.output.parse({ org })) : notFound();
  } catch (error) {
    return unavailable(deps, "orgs.view", error);
  }
}

/** `POST` and `DELETE /api/v1/orgs/{orgId}/spend`: an org admin gives or takes `org:spend` for a wallet. */
export async function orgSpendHttp(
  deps: AgentHttpDeps,
  call: "grant" | "remove",
  input: { me: { userId: string }; orgUserId: string; body: unknown; authority: Pick<OrgAuthority, "grantSpend" | "removeSpend"> }
): Promise<AgentHttpResponse> {
  const routeId = `orgs.spend.${call}`;
  const parsed = orgSpendOperation.input.safeParse(input.body);
  if (!parsed.success) return respond({ error: "invalid input" }, 400);
  try {
    if (call === "grant") return respond(orgSpendOperation.output.parse(await input.authority.grantSpend(input.me, input.orgUserId, parsed.data.wallet)));
    const result = await input.authority.removeSpend(input.me, input.orgUserId, parsed.data.wallet);
    return respond(orgSpendOperation.output.parse({ ...result, held: false }));
  } catch (error) {
    if (error instanceof OwnerSourceUnavailableError) return statementDown();
    if (error instanceof OrgAccountError) {
      if (error.code === "not_allowed" || error.code === "not_found") return notFound();
      if (error.code === "invalid_wallet") return respond({ error: error.code }, 400);
    }
    return unavailable(deps, routeId, error);
  }
}

/**
 * The ONE mapping of a Bill-to refusal to a response, for every route that bills an org account (chat, the internal run route): a chosen org the person may not use is 403
 * `bill_to_not_allowed`; a suspended org is 403 `org_suspended` with its reason; a disconnected org, or a service its statement no longer enables, is 403 `org_disconnected`; an org statement that cannot be read (so the person's role cannot be decided) is 503 `statement_unavailable`. Null for any other error.
 */
export function billToRefusalHttp(error: unknown): AgentHttpResponse | null {
  if (!(error instanceof OrgAccountError)) return null;
  if (error.code === "org_suspended") return respond({ error: "org_suspended", reason: error.message }, 403);
  if (error.code === "statement_unavailable") return respond({ error: "statement_unavailable" }, 503);
  if (error.code === "org_disconnected") return respond({ error: "org_disconnected", reason: error.message }, 403);
  if (error.code === "not_allowed") return respond({ error: "bill_to_not_allowed" }, 403);
  return null;
}

/**
 * The ONE mapping of a funding refusal (`resolveFundingAccount`, `logOrgFunded`) to a response: `not_allowed` is 403 `not_allowed` (an unknown account answers the same); a suspended org is 403
 * `org_suspended` with its reason; an org statement that cannot be read is 503 `statement_unavailable`; `invalid_amount` and `invalid_payment_ref` are 400. Null for any other error.
 */
export function fundingRefusalHttp(error: unknown): AgentHttpResponse | null {
  if (!(error instanceof OrgAccountError)) return null;
  if (error.code === "not_allowed") return respond({ error: "not_allowed" }, 403);
  if (error.code === "org_suspended") return respond({ error: "org_suspended", reason: error.message }, 403);
  if (error.code === "statement_unavailable") return respond({ error: "statement_unavailable" }, 503);
  if (error.code === "invalid_amount" || error.code === "invalid_payment_ref") return respond({ error: error.code }, 400);
  return null;
}

/**
 * `POST /api/v1/orgs/connect` and `/disconnect`: the org's node calls this node, server to server. `authorization` is the raw `Authorization` header; `verify` is the node's
 * verifier of org service assertions (only an origin of the fleet directory). The assertion must be service `org-connect` with the matching scope; its issuer is the org's origin.
 */
export async function orgConnectHttp(
  deps: AgentHttpDeps,
  call: "connect" | "disconnect",
  input: { authorization: string | null; verify: (token: string) => Promise<ServiceAssertionResult>; authority: Pick<OrgAuthority, "connectOrg" | "disconnectOrg"> }
): Promise<AgentHttpResponse> {
  const routeId = `orgs.${call}`;
  const unauthorized = respond({ error: "unauthorized" }, 401);
  const header = input.authorization ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return unauthorized;
  const token = header.slice(7).trim();
  let verified: ServiceAssertionResult;
  try {
    verified = await input.verify(token);
  } catch (error) {
    return unavailable(deps, routeId, error);
  }
  if (!verified.ok) return verified.code === "jwks_unavailable" ? respond({ error: "keys_unavailable" }, 503) : unauthorized;
  const wanted = call === "connect" ? ORG_CONNECT_SCOPE : ORG_DISCONNECT_SCOPE;
  if (verified.service !== ORG_CONNECT_SERVICE || !verified.scope.split(" ").includes(wanted)) return unauthorized;
  try {
    if (call === "disconnect") {
      const result = await input.authority.disconnectOrg(verified.issuer);
      return result ? respond(orgConnectOperation.output.parse({ status: result.status, reason: result.reason, applied: result.applied, version: result.version })) : notFound();
    }
    const result = await input.authority.connectOrg(verified.issuer);
    return respond(orgConnectOperation.output.parse({ status: result.status, reason: result.reason, applied: result.applied, version: result.version }));
  } catch (error) {
    if (error instanceof OwnerSourceUnavailableError) return respond({ error: "statement_unavailable", reason: error.reason }, 502);
    if (error instanceof OrgAccountError) {
      if (error.code === "not_in_directory" || error.code === "wrong_node") return respond({ error: error.code }, 403);
      if (error.code === "node_id_taken") return respond({ error: error.code }, 409);
    }
    return unavailable(deps, routeId, error);
  }
}

/** `GET`, `POST` and `DELETE /api/v1/org-connections`: the org's own admin lists, connects and disconnects its accounts on other nodes. */
export async function orgConnectionsHttp(
  deps: AgentHttpDeps,
  call: "list" | "connect" | "disconnect",
  input: { adminUserId: string; after?: string | null; body?: unknown; authority: OrgConnectionsAuthority }
): Promise<AgentHttpResponse> {
  const routeId = `orgs.connections.${call}`;
  try {
    if (call === "list") return respond(orgConnectionsOperation.list.parse(await input.authority.list(input.after ?? null)));
    const parsed = orgConnectionsOperation.input.safeParse(input.body);
    if (!parsed.success) return respond({ error: "invalid input" }, 400);
    const result = call === "connect" ? await input.authority.connect(parsed.data.origin, input.adminUserId) : await input.authority.disconnect(parsed.data.origin, input.adminUserId);
    return respond(orgConnectionsOperation.output.parse(result));
  } catch (error) {
    if (error instanceof OrgAccountError) {
      if (error.code === "not_in_directory") return respond({ error: "not_in_directory" }, 400);
      if (error.code === "wrong_node") return respond({ error: "wrong_node" }, 409);
      if (error.code === "no_signer") return respond({ error: "signer_unavailable" }, 503);
      if (error.code === "unversioned") return respond({ error: "unversioned" }, 503);
    }
    return unavailable(deps, routeId, error);
  }
}

/** `GET /api/v1/admin/orgs` and `POST /api/v1/admin/orgs/{orgId}/suspension`: this node's admin lists org accounts and suspends or restores one. The admin session is already checked. */
export async function adminOrgsHttp(
  deps: AgentHttpDeps,
  call: "list" | "set",
  input: { adminUserId: string; orgUserId?: string; after?: string | null; body?: unknown; authority: Pick<OrgAuthority, "adminOrgs" | "setSuspension"> }
): Promise<AgentHttpResponse> {
  const routeId = `admin.orgs.${call}`;
  try {
    if (call === "list") return respond(adminOrgsOperation.list.parse(await input.authority.adminOrgs(input.after ?? null)));
    const parsed = adminOrgsOperation.input.safeParse(input.body);
    if (!parsed.success || !input.orgUserId) return respond({ error: "invalid_reason" }, 400);
    const result = await input.authority.setSuspension({ by: input.adminUserId, orgUserId: input.orgUserId, suspend: parsed.data.suspend, reason: parsed.data.reason });
    return respond(adminOrgsOperation.output.parse({ orgUserId: input.orgUserId, status: result.status }));
  } catch (error) {
    if (error instanceof OrgAccountError) {
      if (error.code === "not_found") return notFound();
      if (error.code === "invalid_reason") return respond({ error: error.code }, 400);
      if (error.code === "already_suspended" || error.code === "not_suspended") return respond({ error: error.code }, 409);
    }
    return unavailable(deps, routeId, error);
  }
}
