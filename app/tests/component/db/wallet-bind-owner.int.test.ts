// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/wallet-bind-owner.int.test`
 * Purpose: ONE_WALLET_ONE_KEY on a real database: an agent binds W, then a SIWE login with W in checksummed form cannot create a second owner,
 *   and claimant resolution never pays a sign-in wallet to either of them (AUTH_IS_NOT_PAYMENT).
 * Scope: `createBinding` (the login write), the unique index, and DrizzleClaimantWalletResolver, as the real service role.
 * Invariants: ONE_WALLET_ONE_KEY; NO_AUTO_MERGE; AUTH_IS_NOT_PAYMENT.
 * Side-effects: IO (testcontainers Postgres)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { DrizzleClaimantWalletResolver } from "@cogni/db-client";
import { normalizeWalletAddress } from "@cogni/node-shared";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import postgres, { type Sql } from "postgres";
import { getAddress } from "viem";
import { generateTestWallet } from "@tests/_fixtures/auth/siwe-helpers";
import { SiweMessage } from "siwe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// NextAuth hands authorize() a CSRF token as the SIWE nonce; fix it so the test can sign for it.
vi.mock("next-auth/react", () => ({ getCsrfToken: async () => "csrfnonce12345" }));

import { createBinding } from "@/adapters/server/identity/create-binding";

describe("an agent-bound wallet has one owner and a sign-in wallet is never paid (real Postgres)", () => {
  let service: Sql;
  const users: string[] = [];
  const hex = () => `0x${randomUUID().replaceAll("-", "").padEnd(40, "a").slice(0, 40)}`;

  const makeUser = async (walletAddress?: string) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name, wallet_address) VALUES (${id}, ${`t-${id.slice(0, 6)}`}, ${walletAddress ?? null})`;
    users.push(id);
    return id;
  };

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });

  afterAll(async () => {
    await service?.unsafe("DELETE FROM identity_events WHERE user_id = ANY($1)", [users]).catch(() => undefined);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]).catch(() => undefined);
    await service?.end({ timeout: 1 });
  });

  it("a SIWE login with the checksummed wallet creates no second owner and is not paid", async () => {
    const wallet = normalizeWalletAddress(hex());
    const checksummed = getAddress(wallet);
    const agent = await makeUser();
    await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('external', NULL, ${agent})`;
    const db = getSeedDb();

    // The agent binds W through the bind route's write.
    expect((await createBinding(db, agent, "wallet", wallet, { method: "siwe_bind" })).created).toBe(true);

    // A human then signs in with W in checksummed form: login writes the same lowercase key and the binding is NOT created.
    const human = await makeUser(checksummed);
    expect((await createBinding(db, human, "wallet", normalizeWalletAddress(checksummed), { method: "siwe" })).created).toBe(false);
    // A writer that forgot to normalize is stopped by the database, not by convention.
    await expect(
      service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${human}, 'wallet', ${checksummed})`
    ).rejects.toThrow(/user_bindings_wallet_lower_unique/);

    const owners = await service`SELECT user_id FROM user_bindings WHERE provider = 'wallet' AND lower(external_id) = ${wallet}`;
    expect(owners.map((r) => r.user_id)).toEqual([agent]);

    // W is a sign-in wallet for the agent and the human's login row carries it too: neither has a payout address, so nobody is paid.
    const resolved = await new DrizzleClaimantWalletResolver(db).resolveWallets([`user:${human}`, `user:${agent}`]);
    expect(resolved.map((r) => r.wallet)).toEqual([null, null]);
  });

  it("a SIWE login with a wallet an agent already bound signs in as that same user and creates no new user (defect: login minted a second, powerless user for the wallet)", async () => {
    const signer = generateTestWallet(`login-owner-${randomUUID()}`);
    const agent = await makeUser();
    await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('external', NULL, ${agent})`;
    await createBinding(getSeedDb(), agent, "wallet", normalizeWalletAddress(signer.account.address), { method: "siwe_bind" });

    const { authOptions } = await import("@/auth");
    const provider = authOptions.providers.find((p) => p.id === "credentials") as unknown as {
      options: { authorize: (c: Record<string, string>, req: { headers: Record<string, string> }) => Promise<{ id: string } | null> };
    };
    const origin = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
    const message = new SiweMessage({
      domain: new URL(origin).host,
      address: signer.account.address,
      statement: "Sign in",
      uri: origin,
      version: "1",
      chainId: 1,
      nonce: "csrfnonce12345",
    }).prepareMessage();
    const signature = await signer.account.signMessage({ message });

    const loggedIn = await provider.options.authorize({ message, signature }, { headers: {} });

    expect(loggedIn?.id).toBe(agent);
    // Scoped to this wallet: other component files create users concurrently, so a table-wide count would race.
    const minted = await service`SELECT id FROM users WHERE lower(wallet_address) = ${normalizeWalletAddress(signer.account.address)}`;
    expect(minted).toEqual([]);
  }, 60_000);
});
