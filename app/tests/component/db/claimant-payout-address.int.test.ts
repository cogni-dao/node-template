// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/claimant-payout-address.int.test`
 * Purpose: AUTH_IS_NOT_PAYMENT and BENEFICIARY_IS_ACCEPTED on the claimant path, over a real Postgres (service role). Each case names the defect it catches.
 * Scope: DrizzleClaimantWalletResolver and the shared payout resolution, with payout_addresses and payout_beneficiaries rows written the way the routes write them.
 * Invariants: AUTH_IS_NOT_PAYMENT; NO_ADDRESS_IS_HELD; BENEFICIARY_IS_ACCEPTED; EARNER_NEVER_REWRITTEN; FREEZE_AT_CUTOFF.
 * Side-effects: IO (testcontainers Postgres)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { DrizzleClaimantWalletResolver } from "@cogni/db-client";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("claimant payout resolution reads only payout config (real Postgres)", () => {
  let service: Sql;
  const users: string[] = [];
  const addr = () => `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`;
  const resolve = (keys: string[], asOf?: Date) => new DrizzleClaimantWalletResolver(getSeedDb()).resolveWallets(keys, asOf);

  const makeUser = async (opts: { signInWallet?: string; agent?: boolean; payout?: string } = {}) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name, wallet_address) VALUES (${id}, ${`t-${id.slice(0, 6)}`}, ${opts.signInWallet ?? null})`;
    if (opts.signInWallet)
      await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${id}, 'wallet', ${opts.signInWallet})`;
    if (opts.agent) await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('external', NULL, ${id})`;
    if (opts.payout) await service`INSERT INTO payout_addresses (user_id, address) VALUES (${id}, ${opts.payout})`;
    users.push(id);
    return id;
  };
  const beneficiary = (earner: string, human: string, acceptedAt: string, revokedAt: string | null = null) =>
    service`INSERT INTO payout_beneficiaries (id, earner_user_id, beneficiary_user_id, accepted_at, revoked_at)
      VALUES (${randomUUID()}, ${earner}, ${human}, ${acceptedAt}, ${revokedAt})`;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });

  afterAll(async () => {
    await service?.unsafe("DELETE FROM payout_beneficiaries WHERE earner_user_id = ANY($1) OR beneficiary_user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM payout_addresses WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
  });

  it("never pays a sign-in wallet: a human who signs in with W and has no payout address is held (defect: login wallet was paid)", async () => {
    const human = await makeUser({ signInWallet: addr() });
    expect(await resolve([`user:${human}`])).toEqual([{ claimantKey: `user:${human}`, userId: human, wallet: null }]);
  });

  it("pays the payout address P, never the sign-in wallet W, and changing W changes nothing", async () => {
    const w = addr();
    const p = addr();
    const human = await makeUser({ signInWallet: w, payout: p });
    expect((await resolve([`user:${human}`]))[0]?.wallet).toBe(p);
    await service`DELETE FROM user_bindings WHERE user_id = ${human}`;
    await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${human}, 'wallet', ${addr()})`;
    expect((await resolve([`user:${human}`]))[0]?.wallet).toBe(p);
  });

  it("holds a principal with no payout address whatever its kind (defect: an agent was skipped by kind, a human paid by login wallet)", async () => {
    const human = await makeUser();
    const agent = await makeUser({ agent: true, signInWallet: addr() });
    const out = await resolve([`user:${human}`, `user:${agent}`]);
    expect(out.map((r) => r.wallet)).toEqual([null, null]);
  });

  it("pays an AI's earnings to its accepted beneficiary's payout address, and the earner stays the AI", async () => {
    const p = addr();
    const human = await makeUser({ payout: p });
    const agent = await makeUser({ agent: true });
    await beneficiary(agent, human, "2026-01-01T00:00:00Z");

    const [row] = await resolve([`user:${agent}`], new Date("2026-06-01T00:00:00Z"));

    expect(row).toEqual({ claimantKey: `user:${agent}`, userId: agent, wallet: p });
  });

  it("holds an AI whose beneficiary has no payout address, even when the AI has an address of its own (defect: fell back to the earner)", async () => {
    const human = await makeUser();
    const agent = await makeUser({ agent: true, payout: addr() });
    await beneficiary(agent, human, "2026-01-01T00:00:00Z");
    expect((await resolve([`user:${agent}`], new Date("2026-06-01T00:00:00Z")))[0]?.wallet).toBeNull();
  });

  it("freezes at the cutoff: a row accepted after it, or revoked before it, pays nobody (defect: current policy reinterpreted old work)", async () => {
    const p = addr();
    const human = await makeUser({ payout: p });
    const acceptedLate = await makeUser({ agent: true });
    const revokedEarly = await makeUser({ agent: true });
    const inForce = await makeUser({ agent: true });
    await beneficiary(acceptedLate, human, "2026-09-01T00:00:00Z");
    await beneficiary(revokedEarly, human, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
    await beneficiary(inForce, human, "2026-01-01T00:00:00Z", "2026-09-01T00:00:00Z");

    const out = await resolve([`user:${acceptedLate}`, `user:${revokedEarly}`, `user:${inForce}`], new Date("2026-06-01T00:00:00Z"));

    expect(out.map((r) => r.wallet)).toEqual([null, null, p]);
  });

  it("a proposal nobody accepted pays no one", async () => {
    const agent = await makeUser({ agent: true });
    await service`INSERT INTO payout_beneficiaries (id, earner_user_id, link_hash, link_expires_at) VALUES (${randomUUID()}, ${agent}, ${randomUUID()}, now() + interval '1 day')`;
    expect((await resolve([`user:${agent}`]))[0]?.wallet).toBeNull();
  });
});
