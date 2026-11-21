// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/claimant-wallet-resolver-agent.int.test`
 * Purpose: AGENT_WALLET_IS_NOT_A_PAYEE on the claimant path: a claimant whose user is an agent principal resolves to no wallet, even with a wallet bound.
 * Scope: DrizzleClaimantWalletResolver over a real Postgres (service role). The payout-table trigger is covered in agent-authority.int.test.ts.
 * Invariants: RESOLVER_NULL_IS_UNRESOLVED; AGENT_WALLET_IS_NOT_A_PAYEE.
 * Side-effects: IO (testcontainers Postgres)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { DrizzleClaimantWalletResolver } from "@cogni/db-client";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("claimant wallet resolver skips agent-owned wallets (real Postgres)", () => {
  let service: Sql;
  const users: string[] = [];
  const addr = () =>
    `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`;

  const makeUser = async (wallet: string, agent: boolean) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`t-${id.slice(0, 6)}`})`;
    await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${id}, 'wallet', ${wallet})`;
    if (agent)
      await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('external', NULL, ${id})`;
    users.push(id);
    return id;
  };

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL)
      throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });

  afterAll(async () => {
    await service?.unsafe(
      "DELETE FROM agent_principals WHERE user_id = ANY($1)",
      [users]
    );
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [
      users,
    ]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
  });

  it("resolves a human's wallet and leaves an agent's claimant unresolved", async () => {
    const humanWallet = addr();
    const human = await makeUser(humanWallet, false);
    const agent = await makeUser(addr(), true);

    const resolved = await new DrizzleClaimantWalletResolver(
      getSeedDb()
    ).resolveWallets([`user:${human}`, `user:${agent}`]);

    expect(resolved).toEqual([
      { claimantKey: `user:${human}`, userId: human, wallet: humanWallet },
      { claimantKey: `user:${agent}`, userId: agent, wallet: null },
    ]);
  });

  it("denies a human binding when an agent display wallet owns the same address in another case", async () => {
    const shared = addr();
    const human = await makeUser(
      shared.toUpperCase().replace("0X", "0x"),
      false
    );
    const agent = await makeUser(addr(), true);
    await service`UPDATE users SET wallet_address = ${shared.toLowerCase()} WHERE id = ${agent}`;
    const [resolved] = await new DrizzleClaimantWalletResolver(
      getSeedDb()
    ).resolveWallets([`user:${human}`]);
    expect(resolved).toMatchObject({
      claimantKey: `user:${human}`,
      userId: human,
      wallet: null,
    });
  });

  it("denies a mixed-case agent wallet binding even when the agent has no display wallet", async () => {
    const agent = await makeUser(
      addr().toUpperCase().replace("0X", "0x"),
      true
    );
    const [resolved] = await new DrizzleClaimantWalletResolver(
      getSeedDb()
    ).resolveWallets([`user:${agent}`]);
    expect(resolved).toMatchObject({ userId: agent, wallet: null });
  });
});
