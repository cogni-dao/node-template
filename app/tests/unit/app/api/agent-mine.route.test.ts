// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/agent-mine.route`
 * Purpose: The profile's human routes (task.5465): `/api/v1/agent-access/mine` (GET, POST On, DELETE Off or deny) and `/mine/preview`. Session only: any
 *   Authorization header is 403 `human_session_required` (R9), signed out is 401, a resolved bearer identity is 401, never a person. The approver is the
 *   session, the account is the one that person owns, and a node-admin session adds nothing. The decision is the package's real one gate over a memory store.
 * Scope: The real route handlers and the real package services over the package's memory store; fake session and container; no database, no network.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, ONE_GATE, APPROVER_FOLLOWS_RESOURCE, NON_DISCLOSING, HUMAN_SURFACE_TOKENLESS (no token in any response).
 * Side-effects: none
 */

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { memoryStore } from "../../../../../packages/agent-grants/tests/memory-store";

const fake = vi.hoisted(() => ({
  user: null as unknown,
  authority: null as unknown,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: fake.log }, request),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => fake.user) }));
vi.mock("@/bootstrap/container", () => ({ getContainer: () => ({ log: fake.log, agentAuthority: fake.authority }) }));

import { hashLinkToken, newLinkToken } from "@cogni/agent-grants";
import { DELETE, GET, POST } from "@/app/api/v1/agent-access/mine/route";
import { POST as PREVIEW } from "@/app/api/v1/agent-access/mine/preview/route";

const URL_ = "http://node.test/api/v1/agent-access/mine";
const person = (id: string, via: "session" | "bearer" = "session") => ({ id, walletAddress: null, displayName: null, avatarColor: null, via });
const call = (handler: typeof GET, init: { method?: string; headers?: Record<string, string>; body?: unknown; url?: string } = {}) =>
  handler(
    new NextRequest(init.url ?? URL_, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    undefined as never
  );
const post = (body: unknown, headers: Record<string, string> = {}) => call(POST, { method: "POST", body, headers });
const del = (body: unknown, headers: Record<string, string> = {}) => call(DELETE, { method: "DELETE", body, headers });
const preview = (body: unknown, headers: Record<string, string> = {}) => call(PREVIEW, { method: "POST", url: `${URL_}/preview`, body, headers });

let store: ReturnType<typeof memoryStore>;

const TOKEN_RE = /[A-Za-z0-9_-]{43}/;

beforeEach(() => {
  vi.clearAllMocks();
  store = memoryStore({
    principals: { "node-ai": "ai-1" },
    names: { "ext-1": "Reader bot" },
    accounts: { alice: "acct-alice", bob: "acct-bob" },
  });
  fake.user = person("alice");
});

// For these route tests the behavior under test is the route and the real package functions, so the authority is a thin object over the package
// functions and the memory store (the SQL itself is proven in the component suite over real Postgres).
import * as pkg from "@cogni/agent-grants";
function wire() {
  const declaredScopes = ["account:read"];
  const declarations = { "account:read": { label: "Read your credit balance", description: "See the credit balance of the account it acts for." } };
  fake.authority = {
    previewAsk: async ({ token, resource }: { token: string; resource: "node" | "account" }) => {
      const ask = await pkg.previewAsk(store, { token, resource });
      return ask ? pkg.buildAskView(ask, declarations) : null;
    },
    listMine: async (userId: string) => {
      const accountId = await store.accountOf(userId);
      const rows = accountId ? await store.listAccountRoleRows(accountId, 50) : [];
      return { permissions: pkg.buildAccountAiView({ declarations, scopesByPrincipal: { "node-ai": ["account:read"] }, internal: await store.listInternalPrincipals(), rows, ask: null }), more: 0 };
    },
    turnMineOn: async (me: pkg.ApprovalCaller, input: { token: string; days?: number } | { principalUserId: string; scope: string; days?: number }) => {
      if ("token" in input) return { changed: (await pkg.approveAccountAsk(store, { me, token: input.token, days: input.days })).approved };
      return { changed: (await pkg.grantInternalOnAccount(store, { me, ...input, declaredScopes })).created };
    },
    turnMineOff: async (me: pkg.ApprovalCaller, input: { rowId: string } | { token: string }) =>
      "rowId" in input
        ? { changed: (await pkg.revokeAccountRow(store, { me, rowId: input.rowId })).revoked }
        : { changed: (await pkg.denyAccountAsk(store, { me, token: input.token })).denied },
  };
}
const ask = async (principal: string) => {
  const token = newLinkToken();
  await store.requestRole({ principalUserId: principal, scope: "account:read", resource: "account", link: { hash: await hashLinkToken(token), expiresAt: new Date(Date.now() + 60_000) }, maxPending: 3, maxPendingTotal: 50 });
  return token;
};

describe("session only (R9): a bearer, a header, or no session never decides", () => {
  beforeEach(wire);
  it("any Authorization header is 403 human_session_required on every verb and the preview, even a valid-looking key", async () => {
    const headers = { authorization: "Bearer cogni_ag_sk_v1_x" };
    const token = await ask("ext-1");
    for (const res of [
      await call(GET, { headers }),
      await post({ token }, headers),
      await del({ rowId: "11111111-1111-4111-8111-111111111111" }, headers),
      await preview({ token }, headers),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "human_session_required" });
    }
    expect(await store.hasLiveAccountGrant("ext-1", "account:read", "acct-alice")).toBe(false); // nothing was decided
  });

  it("signed out is 401, and a resolved bearer identity is 401 too, never a person", async () => {
    fake.user = null;
    expect((await call(GET)).status).toBe(401);
    expect((await post({ principalUserId: "ai-1", scope: "account:read" })).status).toBe(401);
    expect((await preview({ token: "x".repeat(43) })).status).toBe(401);
    fake.user = person("alice", "bearer");
    expect((await call(GET)).status).toBe(401);
    expect((await post({ principalUserId: "ai-1", scope: "account:read" })).status).toBe(401);
  });

  it("every answer is no-store", async () => {
    expect((await call(GET)).headers.get("cache-control")).toBe("no-store");
    expect((await post({})).headers.get("cache-control")).toBe("no-store");
  });
});

describe("the person's own table and decisions", () => {
  beforeEach(wire);

  it("lists this node's AI Off for the signed-in person, with no node rows and no token", async () => {
    const res = await call(GET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissions).toEqual([expect.objectContaining({ section: "node", who: "node-ai", scope: "account:read", on: false, resource: "account", rowId: null })]);
    expect(JSON.stringify(body)).not.toMatch(TOKEN_RE);
  });

  it("the preview shows the waiting ask by token, and one 404 for a node token, a used token and an unknown token", async () => {
    const token = await ask("ext-1");
    const ok = await preview({ token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ permission: expect.objectContaining({ section: "pending", who: "Reader bot", outside: true, viaLink: true, rowId: null }) });
    expect((await preview({ token: "z".repeat(43) })).status).toBe(404);
    expect((await preview({ token: "short" })).status).toBe(404);
    expect((await preview({})).status).toBe(404);
    expect(await post({ token, days: 7 })).toBeTruthy();
    expect((await preview({ token })).status).toBe(404); // used up
  });

  it("On by token: the signed-in person is the approver, the row names THEIR account, and the days they picked set its end; the response carries no token", async () => {
    const token = await ask("ext-1");
    const res = await post({ token, days: 30 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true });
    expect(await store.hasLiveAccountGrant("ext-1", "account:read", "acct-alice")).toBe(true);
    expect(await store.hasLiveAccountGrant("ext-1", "account:read", "acct-bob")).toBe(false);
    const row = store.roles.find((r) => r.principal === "ext-1");
    expect(row?.approvedBy).toBe("alice");
    expect(Math.round(((row?.expiresAt ?? 0) - store.clock.now) / 86_400_000)).toBe(30);
  });

  it("Off by row id works for the owner only; another person's click on the same row changes nothing and says nothing", async () => {
    await post({ token: await ask("ext-1") });
    const rowId = store.roles.find((r) => r.principal === "ext-1")?.id as string;
    fake.user = person("bob");
    expect(await (await del({ rowId })).json()).toEqual({ changed: false });
    expect(await store.hasLiveAccountGrant("ext-1", "account:read", "acct-alice")).toBe(true);
    fake.user = person("alice");
    expect(await (await del({ rowId })).json()).toEqual({ changed: true });
    expect(await store.hasLiveAccountGrant("ext-1", "account:read", "acct-alice")).toBe(false);
  });

  it("the x dismisses a waiting ask with its token (R15); a token is needed, a row id is not enough", async () => {
    const token = await ask("ext-1");
    expect((await del({ token })).status).toBe(400); // `deny` is required with a token
    expect(await (await del({ token, deny: true })).json()).toEqual({ changed: true });
    expect(await (await post({ token })).json()).toEqual({ changed: false });
  });

  it("this node's AI turns On directly for the person's own account, once, and an outside principal is refused", async () => {
    const on = await post({ principalUserId: "ai-1", scope: "account:read", days: 1 });
    expect(await on.json()).toEqual({ changed: true });
    expect(await store.hasLiveAccountGrant("ai-1", "account:read", "acct-alice")).toBe(true);
    expect(await (await post({ principalUserId: "ai-1", scope: "account:read" })).json()).toEqual({ changed: false }); // already open (v0 limit)
    expect((await post({ principalUserId: "ext-1", scope: "account:read" })).status).toBe(409); // an outside AI must ask
    expect(await store.hasLiveAccountGrant("ext-1", "account:read", "acct-alice")).toBe(false);
  });

  it("validates the body: a token or a principal with scope, days 1, 7 or 30 only", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ token: await ask("ext-1"), principalUserId: "ai-1", scope: "account:read" })).status).toBe(400);
    expect((await post({ principalUserId: "ai-1", scope: "account:read", days: 31 })).status).toBe(400);
    expect((await post({ principalUserId: "ai-1", scope: "made:up" })).status).toBe(400);
  });
});
