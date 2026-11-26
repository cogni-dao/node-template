// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/http`
 * Purpose: The fleet's ONE route core for the agent access routes (task.0175): parse the body, run the authority call, map each refusal to one status and
 *   body, and report an unavailable store. A node's Next route files call it and keep only auth, the response object and the one call.
 * Scope: Framework-free, in the shape of `credentials/http.ts`. Returns `{ status, body, headers }`; builds no `Response`, reads no request, logs nothing itself
 *   (the node's `onUnavailable` logs, because the failure fields are the node's). Who the caller is (a session person, a bearer agent, an admin) stays with the
 *   node: it passes the resolved caller in.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: every 2xx body is parsed through its zod shape in `./http-contracts`.
 *   - FAIL_CLOSED_NON_DISCLOSING: a wrong-shape, used, expired or unknown link token is one 404 `not_found`; a person who owns no account is the same quiet `changed: false`.
 *   - STORE_OUTAGE_IS_503: a store failure is 503 `authz_unavailable`, reported once through `onUnavailable`, never 401 or 500.
 *   - NEVER_CACHED: every response carries `cache-control: no-store`.
 *   - AI_PLANE_IS_BEARER_ONLY: the access-request routes answer a session with 404 `not_found`, as if the route did not exist for it.
 * Side-effects: none beyond the injected calls
 * Links: ./host.ts, ./http-contracts.ts, https://node-template.cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import type { z } from "zod";

import type { ApprovalCaller } from "./approval";
import {
  agentAccessRequestCreateOperation,
  agentAccessRequestListOperation,
  agentMineListOperation,
  agentMineOffOperation,
  agentMeOperation,
  agentMineOnOperation,
  agentPreviewOperation,
  agentRolesListOperation,
  agentRolesOperation,
} from "./http-contracts";
import { AgentRolesError, type AskOutcome, type PrincipalRef } from "./roles";
import type { AdminDecision, GrantResource, NodeAiPermissionView, RoleState, ScopeKind } from "./types";
import type { PrincipalKind } from "./principals";

export * from "./http-contracts";

export const NO_STORE = { "cache-control": "no-store" } as const;

export interface AgentHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: typeof NO_STORE;
}

const respond = (body: unknown, status = 200): AgentHttpResponse => ({ status, body, headers: NO_STORE });
const notFound = (): AgentHttpResponse => respond({ error: "not_found" }, 404);

/** The node reports a store failure: it logs the failure class under the registered event, with the route id. Never a message, token or hash. */
export interface AgentHttpDeps {
  readonly onUnavailable: (routeId: string, error: unknown) => void;
}

/** What a route core reads of a node's authority object (`createAgentToolAuthority` satisfies it). */
export interface AgentAccessAuthority {
  readonly scopeKinds: Readonly<Record<string, ScopeKind>>;
  requestAccess(input: { principalUserId: string; scope: string }): Promise<AskOutcome>;
  listOwnAccess(principalUserId: string): Promise<Array<{ scope: string; state: RoleState; at: string; accountId: string | null }>>;
  listMine(userId: string): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  turnMineOn(
    me: ApprovalCaller,
    input: { token: string; accountId?: string | undefined } | { principalUserId: string; scope: string }
  ): Promise<{ changed: boolean }>;
  turnMineOff(me: ApprovalCaller, input: { rowId: string } | { token: string; accountId?: string | undefined }): Promise<{ changed: boolean }>;
  previewAsk(input: { token: string; resource: GrantResource }): Promise<NodeAiPermissionView | null>;
  boundWallets(userId: string): Promise<string[]>;
  adminCheck(userId: string): Promise<AdminDecision>;
  principalKind(userId: string): Promise<PrincipalKind>;
}

/** What the admin routes call: the node's admin port with the admin session already bound by the node. */
export interface AdminAiAccessCalls {
  list(): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  on(target: { ref: PrincipalRef; scope: string }): Promise<{ principalUserId: string; changed: boolean }>;
  off(target: { ref: PrincipalRef; scope: string }): Promise<{ principalUserId: string; changed: boolean }>;
  dismiss(target: { ref: PrincipalRef; scope: string }): Promise<{ principalUserId: string; changed: boolean }>;
  preview(token: string): Promise<NodeAiPermissionView | null>;
}

const unavailable = (deps: AgentHttpDeps, routeId: string, error: unknown): AgentHttpResponse => {
  deps.onUnavailable(routeId, error);
  return respond({ error: "authz_unavailable" }, 503);
};

type Parsed<T extends z.ZodType> = { ok: true; data: z.infer<T> } | { ok: false; response: AgentHttpResponse };

/** The JSON body through the operation's input shape: unreadable JSON is 400, a wrong shape is 400 with its issues (or `onInvalid`). */
function parseInput<T extends z.ZodType>(body: unknown, schema: T, onInvalid?: () => AgentHttpResponse): Parsed<T> {
  if (body === undefined) return { ok: false, response: respond({ error: "invalid JSON body" }, 400) };
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, response: onInvalid ? onInvalid() : respond({ error: "invalid input", issues: parsed.error.issues }, 400) };
}

/** `POST /api/v1/agent/access-requests`: an outside AI asks for a permission for itself. `body` is the parsed JSON, or `undefined` when the request body was not JSON. */
export async function accessRequestCreateHttp(
  deps: AgentHttpDeps,
  input: { via: "bearer" | "session"; principalUserId: string; body: unknown; origin: string; authority: Pick<AgentAccessAuthority, "requestAccess"> }
): Promise<AgentHttpResponse> {
  if (input.via !== "bearer") return notFound();
  const parsed = parseInput(input.body, agentAccessRequestCreateOperation.input);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await input.authority.requestAccess({ principalUserId: input.principalUserId, scope: parsed.data.scope });
    // The one link for the person who decides, picked by the scope's declared kind. The token is in the fragment, so no server log or referrer sees it.
    const { approvalPath, ...rest } = result;
    return respond(
      agentAccessRequestCreateOperation.output.parse({
        scope: parsed.data.scope,
        ...rest,
        ...(approvalPath ? { approvalUrl: `${input.origin}${approvalPath}` } : {}),
      }),
      result.created ? 201 : 200
    );
  } catch (error) {
    if (error instanceof AgentRolesError) {
      if (error.code === "invalid_scope") return respond({ error: "invalid_scope" }, 400);
      if (error.code === "no_external_door") return respond({ error: "no_external_door" }, 400);
      if (error.code === "too_many_requests") return respond({ error: "too_many_requests" }, 429);
    }
    return unavailable(deps, "agent.access.requests.create", error);
  }
}

/** `GET /api/v1/agent/access-requests`: an outside AI lists its own asks and grants. */
export async function accessRequestListHttp(
  deps: AgentHttpDeps,
  input: { via: "bearer" | "session"; principalUserId: string; authority: Pick<AgentAccessAuthority, "listOwnAccess"> }
): Promise<AgentHttpResponse> {
  if (input.via !== "bearer") return notFound();
  try {
    return respond(agentAccessRequestListOperation.output.parse({ requests: await input.authority.listOwnAccess(input.principalUserId) }));
  } catch (error) {
    return unavailable(deps, "agent.access.requests.list", error);
  }
}

/** The person's own table. `me` is the signed-in person (the node refused any non-session caller before this). */
export type MineCall = "list" | "on" | "off" | "preview";

export async function mineHttp(
  deps: AgentHttpDeps,
  call: MineCall,
  /** `via` is the literal `"session"`: the human plane takes a signed-in person only, and the node has refused every other credential before this call. */
  input: { me: ApprovalCaller; via: "session"; body?: unknown; authority: AgentAccessAuthority }
): Promise<AgentHttpResponse> {
  const routeId = `agent.mine.${call}`;
  const { authority, me } = input;
  try {
    if (call === "list") return respond(agentMineListOperation.output.parse(await authority.listMine(me.userId)));
    if (call === "preview") {
      // A token of the wrong shape is the same answer as an unknown one.
      const parsed = parseInput(input.body, agentPreviewOperation.input, notFound);
      if (!parsed.ok) return parsed.response;
      const permission = await authority.previewAsk({ token: parsed.data.token, resource: "account" });
      return permission ? respond(agentPreviewOperation.output.parse({ permission })) : notFound();
    }
    if (call === "on") {
      const parsed = parseInput(input.body, agentMineOnOperation.input);
      if (!parsed.ok) return parsed.response;
      // The scope must be one this node declares with kind `account` (SCOPE_KIND_PICKS_THE_PLANE): a node scope is an admin's, never written from the profile.
      if (parsed.data.scope !== undefined && authority.scopeKinds[parsed.data.scope] !== "account") return respond({ error: "invalid_scope" }, 400);
      const result = await authority.turnMineOn(
        me,
        parsed.data.token !== undefined
          ? { token: parsed.data.token, accountId: parsed.data.accountId }
          : { principalUserId: parsed.data.principalUserId as string, scope: parsed.data.scope as string }
      );
      return respond(agentMineOnOperation.output.parse(result));
    }
    const parsed = parseInput(input.body, agentMineOffOperation.input);
    if (!parsed.ok) return parsed.response;
    const result = await authority.turnMineOff(
      me,
      parsed.data.rowId !== undefined
        ? { rowId: parsed.data.rowId }
        : { token: parsed.data.token as string, accountId: parsed.data.accountId }
    );
    return respond(agentMineOffOperation.output.parse(result));
  } catch (error) {
    if (error instanceof AgentRolesError) {
      // A person who owns no account and a request that names no usable row are the same quiet no. Only a bad shape is a 400.
      if (error.code === "not_allowed") return respond({ changed: false });
      if (error.code === "invalid_scope" || error.code === "wrong_kind") return respond({ error: error.code }, 400);
      if (error.code === "principal_not_found" || error.code === "not_pending") return respond({ error: error.code }, 409);
    }
    return unavailable(deps, routeId, error);
  }
}

/** The admin AI-access routes. The node resolved the admin session and binds it into `calls`; a non-admin never reaches this. */
export type AdminAiAccessCall = "list" | "on" | "off" | "preview";

export async function adminAiAccessHttp(
  deps: AgentHttpDeps,
  call: AdminAiAccessCall,
  input: { body?: unknown; calls: AdminAiAccessCalls }
): Promise<AgentHttpResponse> {
  const routeId = `admin.ai-access.${call}`;
  try {
    if (call === "list") return respond(agentRolesListOperation.output.parse({ canManage: true, ...(await input.calls.list()) }));
    if (call === "preview") {
      const parsed = parseInput(input.body, agentPreviewOperation.input, notFound);
      if (!parsed.ok) return parsed.response;
      const permission = await input.calls.preview(parsed.data.token);
      return permission ? respond(agentPreviewOperation.output.parse({ permission })) : notFound();
    }
    const parsed = parseInput(input.body, agentRolesOperation.input);
    if (!parsed.ok) return parsed.response;
    const ref: PrincipalRef =
      parsed.data.principalUserId !== undefined
        ? { principalUserId: parsed.data.principalUserId }
        : { principalSlug: parsed.data.principal as string };
    const target = { ref, scope: parsed.data.scope };
    const result =
      call === "on" ? await input.calls.on(target) : parsed.data.deny === true ? await input.calls.dismiss(target) : await input.calls.off(target);
    return respond(
      agentRolesOperation.output.parse({
        ...(parsed.data.principal !== undefined ? { principal: parsed.data.principal } : {}),
        scope: parsed.data.scope,
        ...result,
      })
    );
  } catch (error) {
    if (error instanceof AgentRolesError && (call === "on" || call === "off")) {
      const status =
        error.code === "principal_not_found"
          ? 404
          : error.code === "not_pending"
            ? 409
            : error.code === "self_approval" || error.code === "not_allowed"
              ? 403
              : 400;
      return respond({ error: error.code }, status);
    }
    if (call === "on" || call === "off") throw error;
    return unavailable(deps, routeId, error);
  }
}

/** The credits read's wire contract, passed in by the node (it is shared with the node's own credits summary route): the query shape and the 2xx body. */
export interface AccountCreditsContract {
  readonly input: z.ZodType<{ limit?: number | undefined }>;
  readonly output: z.ZodType;
}

/**
 * `GET /api/v1/accounts/{accountId}/credits`: the gated read of ONE account, the route twin of `core__account_credits_read`. The node's door
 * (`sameDoor` + `sameDoorAccountParam`) already decided owner, delegated or nothing; the node's `read` runs as the caller under row-level security
 * and answers null for a foreign, expired, revoked, wrong-scope or missing account (ACCOUNT_404_NON_DISCLOSING: one 404). A read failure is not caught:
 * the node's route wrapper answers it.
 */
export async function accountCreditsHttp(input: {
  /** The raw `limit` query value, or null when the query has none. */
  readonly limitParam: string | null;
  readonly contract: AccountCreditsContract;
  readonly read: (limit: number | undefined) => Promise<unknown | null>;
}): Promise<AgentHttpResponse> {
  const parsed = input.contract.input.safeParse({ limit: input.limitParam ? Number(input.limitParam) : undefined });
  if (!parsed.success) return respond({ error: "Invalid query" }, 400);
  const summary = await input.read(parsed.data.limit);
  return summary ? respond(input.contract.output.parse(summary)) : notFound();
}

/** `GET /api/v1/agent/me`: the caller's own access, the same probe on every node. */
export async function agentMeHttp(
  deps: AgentHttpDeps,
  input: { userId: string; via: "bearer" | "session"; authority: Pick<AgentAccessAuthority, "boundWallets" | "adminCheck" | "listOwnAccess" | "principalKind"> }
): Promise<AgentHttpResponse> {
  try {
    const { authority, userId } = input;
    const [wallets, admin, rows, kind] = await Promise.all([
      authority.boundWallets(userId),
      authority.adminCheck(userId),
      authority.listOwnAccess(userId),
      authority.principalKind(userId),
    ]);
    if (admin === "unavailable") return respond({ error: "authz_unavailable" }, 503);
    return respond(
      agentMeOperation.output.parse({
        userId,
        via: input.via,
        kind,
        wallets,
        isAdmin: admin === "allow",
        grants: rows.filter((row) => row.state === "granted").map((row) => ({ scope: row.scope, accountId: row.accountId, since: row.at })),
      })
    );
  } catch (error) {
    return unavailable(deps, "agent.me", error);
  }
}
