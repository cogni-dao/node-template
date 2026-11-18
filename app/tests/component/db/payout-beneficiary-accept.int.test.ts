// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/payout-beneficiary-accept.int.test`
 * Purpose: `acceptBeneficiary` against real Postgres. Each case names the defect it prevents: a guessed, replayed, expired or revoked link, the AI accepting for itself,
 *   and two people accepting one link at once.
 * Scope: The payout facade over the service role, with the app's service-db singleton pointed at the seed client.
 * Invariants: BENEFICIARY_IS_ACCEPTED; NO_SELF_ACCEPTANCE; one live row per earner; the token is single use.
 * Side-effects: IO (testcontainers Postgres)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/adapters/server/db/drizzle.service-client", async () => {
  const { getSeedDb: seedDb } = await import("@tests/_fixtures/db/seed-client");
  return { getServiceDb: () => seedDb() };
});

import { acceptBeneficiary, previewBeneficiary, proposeBeneficiary, revokeBeneficiary } from "@/app/_facades/identity/payout.server";

describe("acceptBeneficiary (real Postgres)", () => {
  let service: Sql;
  const users: string[] = [];

  const makeUser = async (name: string) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${name})`;
    users.push(id);
    return id;
  };
  /** An AI with a pending proposal and the token its link carries. */
  const proposal = async () => {
    const agent = await makeUser(`ai-${randomUUID().slice(0, 6)}`);
    const result = await proposeBeneficiary(agent);
    if (result.status !== "pending") throw new Error("expected a pending proposal");
    return { agent, token: result.token };
  };
  const row = async (agent: string) =>
    (await service`SELECT beneficiary_user_id, accepted_at, revoked_at FROM payout_beneficiaries WHERE earner_user_id = ${agent}`)[0];

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 4 });
    getSeedDb();
  });

  afterAll(async () => {
    await service?.unsafe("DELETE FROM payout_beneficiaries WHERE earner_user_id = ANY($1) OR beneficiary_user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
  });

  it("accepts the right token once and makes the signed-in person the beneficiary", async () => {
    const { agent, token } = await proposal();
    const human = await makeUser("human");
    expect(await acceptBeneficiary(human, token)).toBe(true);
    expect((await row(agent))?.beneficiary_user_id).toBe(human);
  });

  it("refuses a wrong token and changes nothing (defect: a guessed link accepted)", async () => {
    const { agent } = await proposal();
    const human = await makeUser("human");
    expect(await acceptBeneficiary(human, "not-the-token")).toBe(false);
    expect((await row(agent))?.accepted_at).toBeNull();
  });

  it("refuses a replayed token (defect: a used link accepted by a second person)", async () => {
    const { agent, token } = await proposal();
    const first = await makeUser("first");
    const second = await makeUser("second");
    expect(await acceptBeneficiary(first, token)).toBe(true);
    expect(await acceptBeneficiary(second, token)).toBe(false);
    expect((await row(agent))?.beneficiary_user_id).toBe(first);
  });

  it("refuses an expired token, in the accept and in the preview (defect: a stale link still accepted)", async () => {
    const { agent, token } = await proposal();
    const human = await makeUser("human");
    await service`UPDATE payout_beneficiaries SET link_expires_at = now() - interval '1 minute' WHERE earner_user_id = ${agent}`;
    expect(await previewBeneficiary(human, token)).toBeNull();
    expect(await acceptBeneficiary(human, token)).toBe(false);
  });

  it("refuses the earner's own session (defect: an AI accepted its own proposal)", async () => {
    const { agent, token } = await proposal();
    expect(await acceptBeneficiary(agent, token)).toBe(false);
    expect((await row(agent))?.accepted_at).toBeNull();
  });

  it("refuses a revoked row (defect: a withdrawn proposal accepted)", async () => {
    const { agent, token } = await proposal();
    const human = await makeUser("human");
    expect(await revokeBeneficiary({ earnerUserId: agent })).toBe(true);
    expect(await acceptBeneficiary(human, token)).toBe(false);
  });

  it("previews the AI's name for a good token and writes nothing", async () => {
    const { agent, token } = await proposal();
    const human = await makeUser("human");
    const name = (await service`SELECT name FROM users WHERE id = ${agent}`)[0]?.name;
    expect(await previewBeneficiary(human, token)).toEqual({ earnerName: name });
    expect((await row(agent))?.accepted_at).toBeNull();
  });

  it("lets exactly one of two concurrent accepts win (defect: both people became the beneficiary)", async () => {
    const { agent, token } = await proposal();
    const a = await makeUser("a");
    const b = await makeUser("b");
    const results = await Promise.all([acceptBeneficiary(a, token), acceptBeneficiary(b, token)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect([a, b]).toContain((await row(agent))?.beneficiary_user_id);
  });
});
