// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/ai-github-bind.int.test`
 * Purpose: task.0091 on a real database: an AI principal binds a GitHub identity only with a nonce it owns, a GitHub identity a human holds is never taken,
 *   and a receipt authored by the bound GitHub id resolves to the AI as earner (never to a human), with no payout address, so its claim is held.
 * Scope: the real identity binding repository and service, `DrizzleAttributionAdapter.resolveIdentities` and `DrizzleClaimantWalletResolver`, as the service role.
 * Invariants: OWN_NONCE_REQUIRED; NO_AUTO_MERGE; AUTH_IS_NOT_PAYMENT.
 * Side-effects: IO (testcontainers Postgres)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { DrizzleAttributionAdapter, DrizzleClaimantWalletResolver } from "@cogni/db-client";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBinding } from "@/adapters/server/identity/create-binding";
import { DrizzleIdentityBindingRepository } from "@/adapters/server/identity/identity-binding.adapter";
import { createIdentityBindingService } from "@/features/identity/services/operator-attested-binding";

describe("an AI binds its GitHub identity so its receipts resolve to the AI (real Postgres)", () => {
  let service: Sql;
  const users: string[] = [];
  const db = getSeedDb();
  const bindings = createIdentityBindingService({
    repository: new DrizzleIdentityBindingRepository(db),
    clock: { now: () => new Date().toISOString() },
    createNonceId: randomUUID,
  });
  const githubId = () => String(Math.floor(1e9 + Math.random() * 1e9));
  const attested = (userId: string, nonce: string, id: string) => ({
    userId,
    nonce,
    githubId: id,
    githubLogin: "bot-login",
    issuer: "https://operator.test",
    jti: randomUUID(),
    iat: 1,
  });

  const makeUser = async (agent: boolean) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`t-${id.slice(0, 6)}`})`;
    if (agent) await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('external', NULL, ${id})`;
    users.push(id);
    return id;
  };

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });

  afterAll(async () => {
    await service?.unsafe("DELETE FROM identity_events WHERE user_id = ANY($1)", [users]).catch(() => undefined);
    await service?.unsafe("DELETE FROM link_transactions WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]).catch(() => undefined);
    await service?.end({ timeout: 1 });
  });

  it("a receipt authored by the AI's bound GitHub id resolves to the AI, and the AI has no payout address, so it is held", async () => {
    const aiId = await makeUser(true);
    const gh = githubId();

    const nonce = await bindings.createNonce(aiId);
    expect(await bindings.redeemGithubBinding(attested(aiId, nonce, gh))).toBe("created");

    const resolved = await new DrizzleAttributionAdapter(db, randomUUID()).resolveIdentities("github", [gh]);
    expect(resolved.get(gh)).toBe(aiId);
    const wallets = await new DrizzleClaimantWalletResolver(db).resolveWallets([`user:${aiId}`]);
    expect(wallets.map((w) => w.wallet)).toEqual([null]);
  });

  it("a GitHub identity a human already holds is never taken by an AI (defect: the AI's proof re-pointed the human's binding)", async () => {
    const human = await makeUser(false);
    const aiId = await makeUser(true);
    const gh = githubId();
    await createBinding(db, human, "github", gh, { method: "oauth" });

    const nonce = await bindings.createNonce(aiId);
    expect(await bindings.redeemGithubBinding(attested(aiId, nonce, gh))).toBe("already_linked");

    const resolved = await new DrizzleAttributionAdapter(db, randomUUID()).resolveIdentities("github", [gh]);
    expect(resolved.get(gh)).toBe(human);
  });

  it("an AI cannot bind with a nonce another principal minted, and a spent nonce binds nothing (defect: a token alone bound an account)", async () => {
    const owner = await makeUser(true);
    const other = await makeUser(true);
    const gh = githubId();

    const nonce = await bindings.createNonce(owner);
    expect(await bindings.redeemGithubBinding(attested(other, nonce, gh))).toBe("invalid_nonce");
    expect(await bindings.redeemGithubBinding(attested(owner, nonce, gh))).toBe("created");
    expect(await bindings.redeemGithubBinding(attested(owner, nonce, githubId()))).toBe("invalid_nonce");

    const rows = await service`SELECT user_id FROM user_bindings WHERE provider = 'github' AND user_id = ANY(${[owner, other]})`;
    expect(rows.map((r) => r.user_id)).toEqual([owner]);
  });
});
