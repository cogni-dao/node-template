// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/agent-credentials-renew-v1.route`
 * Purpose: renew-v1 (task.0069 C1-C3): a valid v1 key gets a fresh key for the SAME user id; sessions, wallets, internal
 *   principals and calls at or after the hard stop are refused; the env can only shorten the hard stop.
 * Scope: The real route, the real resolver (request-identity.ts) and the real key signer; a fake db and a mocked header
 *   source. No network.
 * Invariants: The new key authenticates through the unchanged verify path with the same `sub`.
 * Side-effects: none
 */

import { agentPrincipals, users } from "@cogni/db-schema";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  env: { AUTH_SECRET: "test-secret-for-unit-tests-only-0123456789" } as Record<string, string | undefined>,
  headers: new Map<string, string>(),
  session: null as null | Record<string, unknown>,
  rows: new Map<unknown, unknown[]>(),
  superseded: false,
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (n: string) => fake.headers.get(n.toLowerCase()) ?? null }),
}));
vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: async () => fake.session }));
vi.mock("@/shared/env/server", () => ({ serverEnv: () => fake.env }));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => ({ everConfirmed: async () => fake.superseded }),
}));
vi.mock("@/bootstrap/container", () => ({
  resolveServiceDb: () => ({
    select: () => ({
      from: (table: unknown) => ({ where: () => ({ limit: async () => fake.rows.get(table) ?? [] }) }),
    }),
  }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      opts: { auth: { getSessionUser: () => Promise<unknown> } },
      handler: (ctx: unknown, request: Request, user: unknown) => Promise<NextResponse>
    ) =>
    async (request: Request) => {
      const user = await opts.auth.getSessionUser();
      if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      return handler({ log: { info: vi.fn(), warn: vi.fn() } }, request, user);
    },
}));

import { getSessionUser } from "@/app/_lib/auth/session";
import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { POST } from "@/app/api/v1/agent/credentials/renew-v1/route";

const USER_ID = "agent-user-1";
const renew = (authorization?: string) => {
  fake.headers.clear();
  if (authorization) fake.headers.set("authorization", authorization);
  return POST(new NextRequest("http://localhost/api/v1/agent/credentials/renew-v1", { method: "POST" }), undefined as never);
};
const oldKey = () => issueAgentApiKey({ userId: USER_ID, displayName: "Flock" });

beforeEach(() => {
  fake.env = { AUTH_SECRET: "test-secret-for-unit-tests-only-0123456789" };
  fake.session = null;
  fake.rows.clear();
  fake.superseded = false;
  fake.rows.set(users, [{ walletAddress: null }]);
});
afterEach(() => vi.useRealTimers());

describe("renew-v1", () => {
  it("a valid v1 key returns a fresh key for the same user, and the new key authenticates with the same sub", async () => {
    const res = await renew(`Bearer ${oldKey()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ userId: USER_ID, legacy: true, hardStop: "2027-01-31T00:00:00.000Z" });
    expect(body.apiKey).toMatch(/^cogni_ag_sk_v1_/);

    fake.headers.set("authorization", `Bearer ${body.apiKey}`);
    const resolved = await getSessionUser();
    expect(resolved).toMatchObject({ id: USER_ID, displayName: "Flock", via: "bearer" });
  });

  it("a v1 key whose user already holds a confirmed v2 key cannot renew (v1_superseded)", async () => {
    fake.superseded = true;
    await expect(renew(`Bearer ${oldKey()}`)).rejects.toMatchObject({ code: "v1_superseded" });
  });

  it("a session caller is 403 and mints nothing", async () => {
    fake.session = { id: USER_ID, walletAddress: null, displayName: "Human", avatarColor: null };
    const res = await renew();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bearer_required" });
  });

  it("no key, a forged key, a wallet user and an internal principal are refused", async () => {
    expect((await renew()).status).toBe(401);
    expect((await renew("Bearer cogni_ag_sk_v1_forged.sig")).status).toBe(401);
    fake.rows.set(users, [{ walletAddress: "0xabc" }]);
    expect((await renew(`Bearer ${oldKey()}`)).status).toBe(403);
    fake.rows.set(users, [{ walletAddress: null }]);
    fake.rows.set(agentPrincipals, [{ id: "p1" }]);
    expect((await renew(`Bearer ${oldKey()}`)).status).toBe(403);
  });

  it("a hard stop in the past (env) is 403 v1_hard_stop", async () => {
    fake.env.AGENT_V1_HARD_STOP = "2020-01-01T00:00:00Z";
    const res = await renew(`Bearer ${oldKey()}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "v1_hard_stop" });
  });

  it("an env hard stop later than the code default is clamped to the default", async () => {
    fake.env.AGENT_V1_HARD_STOP = "2099-01-01T00:00:00Z";
    const body = await (await renew(`Bearer ${oldKey()}`)).json();
    expect(body.hardStop).toBe("2027-01-31T00:00:00.000Z");
  });

  it("a shorter env hard stop caps the new expiry, and an unparsable one disables the route", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-20T00:00:00Z"));
    fake.env.AGENT_V1_HARD_STOP = "2027-01-25T00:00:00Z";
    const body = await (await renew(`Bearer ${oldKey()}`)).json();
    expect(body.expiresAt).toBe("2027-01-25T00:00:00.000Z");
    fake.env.AGENT_V1_HARD_STOP = "not-a-date";
    expect((await renew(`Bearer ${oldKey()}`)).status).toBe(503);
  });

  it("near the default hard stop the new key expires at the hard stop, not 30 days out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-14T00:00:00Z"));
    const body = await (await renew(`Bearer ${oldKey()}`)).json();
    expect(body.expiresAt).toBe("2027-01-31T00:00:00.000Z");
  });
});
