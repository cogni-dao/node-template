// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/identity-wallet-bind.route`
 * Purpose: The wallet challenge/bind pair, driven with real SIWE signatures over an in-memory binding ledger. Each case names the defect it prevents.
 * Scope: Both routes, the shared SIWE verify, the bind service and the admin check's wallet read. The database is replaced by an in-memory repository.
 * Invariants: ONE_ADMIN_CHECK sees a bearer-bound wallet; NONCE_CONSUMED_BEFORE_BINDING; NO_AUTO_MERGE.
 * Side-effects: none
 * Links: src/app/api/v1/identity/wallet/bind/route.ts, src/app/api/v1/identity/wallet/challenge/route.ts
 * @internal
 */

import { randomUUID } from "node:crypto";
import { generateTestWallet } from "@tests/_fixtures/auth/siwe-helpers";
import { NextRequest, type NextResponse } from "next/server";
import { SiweMessage } from "siwe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminCheck } from "@/bootstrap/agent-authority";
import type { IdentityBindingRepositoryPort, IdentityBindingTransactionPort } from "@/ports";

const fake = vi.hoisted(() => ({ user: null as unknown, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const ledger = vi.hoisted(() => ({
  nonces: new Map<string, { userId: string; provider: string; expiresAt: Date; consumed: boolean }>(),
  bindings: [] as Array<{ id: string; userId: string; address: string }>,
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request, user: unknown) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: fake.log }, request, fake.user),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => fake.user) }));
vi.mock("@/adapters/server/db/drizzle.service-client", () => ({ getServiceDb: () => ({}) }));
vi.mock("@/bootstrap/identity", () => {
  const tx: IdentityBindingTransactionPort = {
    async consumeNonce({ nonce, userId, now, provider }) {
      const row = ledger.nonces.get(nonce);
      if (!row || row.consumed || row.userId !== userId || row.provider !== (provider ?? "github") || row.expiresAt <= now) return false;
      row.consumed = true;
      return true;
    },
    async findWalletBinding(address) {
      return ledger.bindings.find((b) => b.address.toLowerCase() === address.toLowerCase()) ?? null;
    },
    async createWalletBinding({ userId, address }) {
      ledger.bindings.push({ id: randomUUID(), userId, address });
      return true;
    },
    findGithubBinding: async () => null,
    updateGithubLogin: async () => undefined,
    createGithubBinding: async () => false,
  };
  const repository: IdentityBindingRepositoryPort = {
    async insertNonce({ nonce, userId, expiresAt, provider }) {
      // One open wallet challenge per principal: a new one retires the last.
      if (provider === "wallet")
        for (const row of ledger.nonces.values()) if (row.userId === userId && row.provider === "wallet") row.consumed = true;
      ledger.nonces.set(nonce, { userId, provider: provider ?? "github", expiresAt, consumed: false });
    },
    transaction: (run) => run(tx),
  };
  return {
    resolveIdentityBindingDependencies: () => ({ repository, clock: { now: () => new Date().toISOString() }, createNonceId: randomUUID }),
  };
});

import { POST as bindRoute } from "@/app/api/v1/identity/wallet/bind/route";
import { POST as challengeRoute } from "@/app/api/v1/identity/wallet/challenge/route";

const as = (id: string, via: "session" | "bearer") => {
  fake.user = { id, walletAddress: null, displayName: null, avatarColor: null, via };
};
const post = (url: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

const wallet = generateTestWallet("wallet-bind-test");
type Fields = { domain: string; uri: string; nonce: string; chainId: number; version: string; statement: string; issuedAt: string };
const challenge = async () => {
  const res = await challengeRoute(post("/api/v1/identity/wallet/challenge"), undefined as never);
  expect(res.status).toBe(200);
  return (await res.json()).message as Fields;
};
/** Sign the challenge exactly as issued, or with one field tampered (what a hostile or confused signer might send). */
const signedBy = async (signer: typeof wallet, fields: Fields, tamper: Partial<ConstructorParameters<typeof SiweMessage>[0]> = {}) => {
  const message = new SiweMessage({ ...fields, address: signer.account.address, ...tamper }).prepareMessage();
  return { message, signature: await signer.account.signMessage({ message }) };
};
const bind = (signed: { message: string; signature: string }) => bindRoute(post("/api/v1/identity/wallet/bind", signed), undefined as never);

/** The admin check's wallet read, answered from the ledger exactly as `user_bindings` would. */
const adminCheckOver = (approved: string) =>
  createAdminCheck(
    ((_strings: TemplateStringsArray, userId: string) =>
      Promise.resolve(ledger.bindings.filter((b) => b.userId === userId).map((b) => ({ external_id: b.address })))) as never,
    { check: async (input) => (input.walletAddress?.toLowerCase() === approved ? { ok: true } : { ok: false, errorCode: "authz_denied" }) }
  );

beforeEach(() => {
  ledger.nonces.clear();
  ledger.bindings.length = 0;
  vi.clearAllMocks();
});

describe("POST /api/v1/identity/wallet/{challenge,bind}", () => {
  it("a bearer agent binds a wallet it signs for, and the one admin check then sees it (defect: AI wallets invisible to adminCheck)", async () => {
    as("agent-1", "bearer");
    const check = adminCheckOver(wallet.account.address.toLowerCase());
    expect(await check("agent-1")).toBe("denied");

    const res = await bind(await signedBy(wallet, await challenge()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ address: wallet.account.address.toLowerCase(), bound: true, created: true });
    expect(ledger.bindings).toEqual([expect.objectContaining({ userId: "agent-1", address: wallet.account.address.toLowerCase() })]);
    expect(await check("agent-1")).toBe("allow");
  });

  it("a replayed signed message binds nothing (defect: a captured bind request re-run)", async () => {
    as("agent-1", "bearer");
    const signed = await signedBy(wallet, await challenge());
    expect((await bind(signed)).status).toBe(200);
    ledger.bindings.length = 0; // even if the first binding were gone, the nonce is spent
    const replay = await bind(signed);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ errorCode: "invalid_nonce" });
    expect(ledger.bindings).toEqual([]);
  });

  it("a nonce minted for one principal cannot bind for another (defect: nonce theft across principals)", async () => {
    as("agent-1", "bearer");
    const fields = await challenge();
    as("agent-2", "bearer");
    const res = await bind(await signedBy(wallet, fields));
    expect(res.status).toBe(400);
    expect(ledger.bindings).toEqual([]);
  });

  it("a wallet another principal already holds is never re-pointed (defect: NO_AUTO_MERGE bypass by address casing)", async () => {
    ledger.bindings.push({ id: "b-1", userId: "human-1", address: wallet.account.address }); // login writes EIP-55 casing
    as("agent-1", "bearer");
    const res = await bind(await signedBy(wallet, await challenge()));
    expect(res.status).toBe(409);
    expect(ledger.bindings).toHaveLength(1);
    expect(ledger.bindings[0]?.userId).toBe("human-1");
  });

  it("a bad signature is refused before any nonce is spent", async () => {
    as("agent-1", "bearer");
    const fields = await challenge();
    const signed = await signedBy(wallet, fields);
    const res = await bind({ message: signed.message, signature: `0x${"00".repeat(65)}` });
    expect(res.status).toBe(401);
    expect(ledger.nonces.get(fields.nonce)?.consumed).toBe(false);
  });

  it("a message for another domain, chain, uri or carrying resources is refused and spends no nonce (defect: a signature obtained for another site binds here)", async () => {
    as("agent-1", "bearer");
    const fields = await challenge();
    const tampers = [
      { domain: "evil.example" },
      { chainId: fields.chainId + 1 },
      { uri: "https://evil.example" },
      { resources: ["https://evil.example/anything"] },
    ];
    for (const tamper of tampers) {
      const res = await bind(await signedBy(wallet, fields, tamper));
      expect(res.status, JSON.stringify(tamper)).toBe(401);
    }
    expect(ledger.nonces.get(fields.nonce)?.consumed).toBe(false);
    expect(ledger.bindings).toEqual([]);
  });

  it("a new challenge retires the previous one, so open nonces cannot pile up (defect: unbounded nonce rows per principal)", async () => {
    as("agent-1", "bearer");
    const first = await challenge();
    const second = await challenge();
    expect((await bind(await signedBy(wallet, first))).status).toBe(400);
    expect((await bind(await signedBy(wallet, second))).status).toBe(200);
  });
});
