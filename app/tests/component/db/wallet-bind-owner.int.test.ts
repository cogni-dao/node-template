// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/wallet-bind-owner.int.test`
 * Purpose: ONE_WALLET_ONE_KEY on a real database: an agent binds W, then a SIWE login with W in checksummed form cannot create a second owner,
 *   and claimant resolution never pays the wallet to either of them.
 * Scope: `createBinding` (the login write), the unique index, and DrizzleClaimantWalletResolver, as the real service role.
 * Invariants: ONE_WALLET_ONE_KEY; NO_AUTO_MERGE; AGENT_WALLET_IS_NOT_A_PAYEE.
 * Side-effects: IO (testcontainers Postgres)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { DrizzleClaimantWalletResolver } from "@cogni/db-client";
import { normalizeWalletAddress } from "@cogni/node-shared";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import postgres, { type Sql } from "postgres";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBinding } from "@/adapters/server/identity/create-binding";

describe("an agent-bound wallet has one owner and is never paid (real Postgres)", () => {
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

    // The human's login row carries W (display casing), but W belongs to an agent: nobody is paid.
    const resolved = await new DrizzleClaimantWalletResolver(db).resolveWallets([`user:${human}`, `user:${agent}`]);
    expect(resolved.map((r) => r.wallet)).toEqual([null, null]);
  });
});
