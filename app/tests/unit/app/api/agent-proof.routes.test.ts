// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/agent-proof.routes`
 * Purpose: The authenticated proof routes and the admin keys switch (task.0091): the bind challenge, bind GitHub, the bearer twins `revoke-principal` and
 *   `lift-stop`, and the `agent:keys` branch of `/api/v1/agent-access/roles` (the human door of the same stop and lift).
 * Scope: The REAL routes, route wrapper, key resolver and package service. Fakes: the credential store (the package's memory store, same semantics as the SQL),
 *   GitHub (a scripted comment), the node admin check, the header source and the session getter. No network, no database.
 * Invariants: bearer-only AI doors; one gate for both doors; a stop kills the next call; stop and lift never write a role; no secret in any log line.
 * Side-effects: none
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { confirmCredential, type CommentRead, upgradeSignedKey, verifyBearer } from "@cogni/agent-grants/credentials";
import { memoryCredentialStore } from "../../../../../packages/agent-grants/tests/credentials-memory-store";

const ISSUE = "cogni-dao/proof-issues#1";
const USER = "agent-proof-user";
const TARGET = "agent-proof-target";
const ADMIN = "node-admin-human";
const AI_ADMIN = "agent-proof-ai-admin";

const fake = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  session: null as null | { id: string; walletAddress: string | null; displayName: string | null; avatarColor: string | null },
  admins: new Set<string>(),
  read: { kind: "not_found" } as { kind: string },
  memory: undefined as unknown as { store: unknown; outage: { failing: boolean; failOn: string | null } },
}));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };

vi.mock("next/headers", () => ({ headers: async () => ({ get: (n: string) => fake.headers.get(n.toLowerCase()) ?? null }) }));
vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: async () => fake.session }));
vi.mock("@/shared/env/server", () => ({ serverEnv: () => ({ AUTH_SECRET: "test-secret-for-unit-tests-only-0123456789" }) }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log,
    config: { unhandledErrorPolicy: "respond_500" },
    clock: { now: () => "2026-11-10T00:00:00Z" },
    agentAuthority: { adminCheck: async (id: string) => (fake.admins.has(id) ? "allow" : "denied") },
  }),
}));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => fake.memory.store,
  getProofConfig: () => ({ nodeId: "node-under-test", issues: ["cogni-dao/proof-issues#1"] }),
  getProofVerifier: () => ({ fetchComment: async () => fake.read }),
  proofAttemptGuards: () => ({ admit: () => true, onInvalid: () => undefined }),
  admitCredentialLookup: () => true,
  recordCredentialMiss: () => undefined,
}));

import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { DELETE as rolesDelete, POST as rolesPost } from "@/app/api/v1/agent-access/roles/route";
import { POST as bind } from "@/app/api/v1/agent/bindings/github/route";
import { POST as liftStop } from "@/app/api/v1/agent/credentials/lift-stop/route";
import { POST as revokePrincipal } from "@/app/api/v1/agent/credentials/revoke-principal/route";
import { POST as challenge } from "@/app/api/v1/agent/proofs/challenge/route";

type Handler = (r: NextRequest, c: never) => Promise<Response>;
const store = () => fake.memory.store as Parameters<typeof upgradeSignedKey>[0];
const memory = () => fake.memory as unknown as ReturnType<typeof memoryCredentialStore>;
const v1 = (userId: string) => issueAgentApiKey({ userId, displayName: "Agent" });
const send = (handler: Handler, key: string | null, body?: unknown, extra: Record<string, string> = {}) => {
  fake.headers.clear();
  if (key) fake.headers.set("authorization", `Bearer ${key}`);
  const headers: Record<string, string> = { ...extra, ...(key ? { authorization: `Bearer ${key}` } : {}) };
  return handler(
    new NextRequest("http://localhost/api/v1/x", {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    undefined as never
  );
};
const roles = (handler: Handler, body: unknown) => {
  fake.headers.clear();
  return handler(new NextRequest("http://localhost/api/v1/agent-access/roles", { method: "POST", body: JSON.stringify(body) }), undefined as never);
};
const events = () => [...log.info.mock.calls, ...log.warn.mock.calls].map((c) => (c[0] as { event?: string }).event).filter((e) => e?.startsWith("agent."));

async function activeKey(userId: string) {
  const up = await upgradeSignedKey(store(), { userId });
  if (!up.ok) throw new Error("upgrade refused");
  await confirmCredential(store(), { credentialId: up.credentialId });
  return up;
}

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  fake.memory = memoryCredentialStore({ users: { [USER]: {}, [TARGET]: {}, [ADMIN]: {}, [AI_ADMIN]: {} } }) as never;
  fake.session = null;
  fake.admins = new Set();
  fake.read = { kind: "not_found" };
});

describe("bind challenge and bind GitHub (AI plane)", () => {
  it("a signed key asks, posts the line, binds (201), and a replay is one 401; the log holds the GitHub id and no secret", async () => {
    const key = v1(USER);
    const asked = await send(challenge as Handler, key); // the body is optional: the route implies bind
    expect(asked.status).toBe(200);
    expect(asked.headers.get("cache-control")).toBe("no-store");
    const ch = await asked.json();
    const at = new Date(Date.parse(ch.expiresAt) - 600_000 + 1000).toISOString();
    fake.read = {
      kind: "found",
      comment: {
        issueUrl: "https://api.github.com/repos/cogni-dao/proof-issues/issues/1",
        userId: 295942454,
        login: "agent-account",
        userType: "User",
        body: ch.proofLine,
        createdAt: at,
        updatedAt: at,
      },
    } as CommentRead;
    const body = { challengeId: ch.challengeId, challengeSecret: ch.challengeSecret, issue: ISSUE, commentId: 5 };
    const bound = await send(bind as Handler, key, body);
    expect(bound.status).toBe(201);
    expect(await bound.json()).toMatchObject({ bound: true, githubId: "295942454", userType: "User", result: "created" });
    expect(memory().bindingsOf(USER)).toEqual(["295942454"]);
    expect(events()).toEqual(["agent.proof.challenge_issued", "agent.binding.created"]);
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).not.toContain(ch.challengeSecret);
    expect(logged).not.toContain("agent-account"); // the login is never logged
    const replay = await send(bind as Handler, key, body);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "invalid_challenge" });
  });

  it("another agent's bearer cannot use the challenge (401); no key is 401; a browser session is 403 not_agent", async () => {
    const ch = await (await send(challenge as Handler, v1(USER), { purpose: "bind" })).json();
    const body = { challengeId: ch.challengeId, challengeSecret: ch.challengeSecret, issue: ISSUE, commentId: 5 };
    expect((await send(bind as Handler, v1(TARGET), body)).status).toBe(401);
    expect((await send(challenge as Handler, null, {})).status).toBe(401);
    fake.session = { id: ADMIN, walletAddress: null, displayName: "Human", avatarColor: null };
    const viaSession = await send(challenge as Handler, null, {});
    expect(viaSession.status).toBe(403);
    expect(await viaSession.json()).toEqual({ error: "not_agent" });
  });

  it("a stopped agent cannot ask: its signed key is already dead (401 v1_superseded)", async () => {
    fake.admins.add(ADMIN);
    fake.session = { id: ADMIN, walletAddress: null, displayName: "Human", avatarColor: null };
    expect((await roles(rolesDelete as Handler, { principalUserId: USER, scope: "agent:keys" })).status).toBe(200);
    fake.session = null;
    const res = await send(challenge as Handler, v1(USER), {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "v1_superseded" });
  });
});

describe("the bearer twins of stop and lift", () => {
  it("a non-admin agent is 403 authz_denied on both; a bearer header on the roles route is 403 human_session_required", async () => {
    const key = v1(USER);
    const stop = await send(revokePrincipal as Handler, key, { principalUserId: TARGET });
    expect(stop.status).toBe(403);
    expect(await stop.json()).toEqual({ error: "authz_denied" });
    expect((await send(liftStop as Handler, key, { principalUserId: TARGET })).status).toBe(403);
    expect(events()).toEqual(["agent.credential.refused", "agent.credential.refused"]);
    const human = await send(rolesDelete as Handler, key, { principalUserId: TARGET, scope: "agent:keys" });
    expect(human.status).toBe(403);
    expect(await human.json()).toMatchObject({ error: "human_session_required" });
  });

  it("an agent the node-admin check allows stops a target with the SAME package gate; the target's next call is 401; it cannot lift itself", async () => {
    fake.admins.add(AI_ADMIN);
    const targetKey = await activeKey(TARGET);
    const key = v1(AI_ADMIN);
    const stopped = await send(revokePrincipal as Handler, key, { principalUserId: TARGET });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ revoked: 1 });
    expect(await verifyBearer(store(), targetKey.apiKey)).toEqual({ ok: false, reason: "invalid" });
    expect(events()).toEqual(["agent.credential.revoked_all"]);
    const self = await send(liftStop as Handler, key, { principalUserId: AI_ADMIN });
    expect(self.status).toBe(403);
    expect(await self.json()).toEqual({ error: "self_lift" });
    const lifted = await send(liftStop as Handler, key, { principalUserId: TARGET });
    expect(lifted.status).toBe(200);
    expect(await lifted.json()).toEqual({ lifted: true });
    expect(await verifyBearer(store(), targetKey.apiKey)).toEqual({ ok: false, reason: "invalid" }); // a lift revives nothing
  });

  it("a browser session is refused (403 bearer_required); bad bodies are 400", async () => {
    fake.admins.add(AI_ADMIN);
    expect((await send(revokePrincipal as Handler, v1(AI_ADMIN), {})).status).toBe(400);
    fake.session = { id: ADMIN, walletAddress: null, displayName: "Human", avatarColor: null };
    expect((await send(revokePrincipal as Handler, null, { principalUserId: TARGET })).status).toBe(403);
  });
});

describe("the keys switch on the roles route (human plane)", () => {
  const asAdmin = () => {
    fake.admins.add(ADMIN);
    fake.session = { id: ADMIN, walletAddress: null, displayName: "Human", avatarColor: null };
  };

  it("Off (DELETE agent:keys) stops the agent: its key is dead on the next call; On (POST) lifts and mints nothing", async () => {
    asAdmin();
    const targetKey = await activeKey(TARGET);
    const off = await roles(rolesDelete as Handler, { principalUserId: TARGET, scope: "agent:keys" });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ scope: "agent:keys", principalUserId: TARGET, changed: true });
    expect(await verifyBearer(store(), targetKey.apiKey)).toEqual({ ok: false, reason: "invalid" });
    expect(events()).toEqual(["agent.credential.revoked_all"]);
    const rows = memory().rows.length;
    const on = await roles(rolesPost as Handler, { principalUserId: TARGET, scope: "agent:keys" });
    expect(on.status).toBe(200);
    expect(memory().rows.length).toBe(rows);
    expect(await verifyBearer(store(), targetKey.apiKey)).toEqual({ ok: false, reason: "invalid" });
    expect(events()).toEqual(["agent.credential.revoked_all", "agent.credential.stop_lifted"]);
    const again = await roles(rolesPost as Handler, { principalUserId: TARGET, scope: "agent:keys" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "not_stopped" });
  });

  it("deny:true and a slug are 400; a non-admin is 403 and changes nothing; a wallet user is 403 not_agent; an unknown id is 404", async () => {
    asAdmin();
    expect((await roles(rolesDelete as Handler, { principalUserId: TARGET, scope: "agent:keys", deny: true })).status).toBe(400);
    expect((await roles(rolesDelete as Handler, { principal: "node-ai", scope: "agent:keys" })).status).toBe(400);
    expect((await roles(rolesDelete as Handler, { principalUserId: "nobody", scope: "agent:keys" })).status).toBe(404);
    fake.memory = memoryCredentialStore({ users: { [TARGET]: { wallet: true } } }) as never;
    expect((await roles(rolesDelete as Handler, { principalUserId: TARGET, scope: "agent:keys" })).status).toBe(403);
    fake.admins.clear();
    const denied = await roles(rolesDelete as Handler, { principalUserId: TARGET, scope: "agent:keys" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "authz_denied" });
  });
});
