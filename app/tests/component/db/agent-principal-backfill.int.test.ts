// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-principal-backfill.int.test`
 * Purpose: The 0044 backfill selector against real Postgres. The defect it guards: a human misread as an agent loses payouts (the payout guard keys on
 *   `agent_principals`), so the selector must pick a registered agent with no principal row and none of the three human creation paths.
 * Scope: Runs the migration file's own INSERT statement (not a copy) over fixtures that mirror each creation path in `auth.ts` and
 *   `operator-attested-binding.server.ts`. Everything runs in one transaction that is rolled back, so no row leaks to other tests
 *   (`identity_events` is append-only and could not be cleaned up otherwise).
 * Invariants: PRECISION_OVER_COVERAGE (only the agent gets a row), IDEMPOTENT (a rerun inserts nothing), INTERNAL_AND_SYSTEM_UNTOUCHED.
 * Side-effects: IO (testcontainers Postgres, rolled back)
 * Notes: DATABASE_SERVICE_URL = BYPASSRLS, so the migration's FORCE-RLS lifts are not needed here.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NODE_AI_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = resolve(__dirname, "../../../src/adapters/server/db/migrations/0044_backfill_agent_principals.sql");
const SYSTEM_TENANT_USER_ID = "00000000-0000-4000-a000-000000000001";
const ROLLBACK = new Error("rollback");

/** The migration's backfill statement, taken from the file itself. */
const backfill = (): string => {
  const statement = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .find((part) => /INSERT INTO "agent_principals"/.test(part));
  if (!statement) throw new Error("0044 has no agent_principals insert");
  return statement.replace(/^\s*--.*$/gm, "").trim();
};

describe("0044 backfill selector (real Postgres)", () => {
  let service: Sql;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });
  afterAll(async () => {
    await service?.end({ timeout: 1 });
  });

  /** Seed one user per creation path plus a registered agent, run `fn`, then roll everything back. */
  const withFixtures = async (
    fn: (ids: { siwe: string; oauth: string; attested: string; agent: string }, tx: TransactionSql) => Promise<void>
  ) => {
    const ids = { siwe: randomUUID(), oauth: randomUUID(), attested: randomUUID(), agent: randomUUID() };
    await service
      .begin(async (tx) => {
        const profile = (id: string) => tx`INSERT INTO user_profiles (user_id) VALUES (${id})`;
        const binding = (id: string, provider: string) =>
          tx`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${id}, ${provider}, ${randomUUID()})`;
        const event = (id: string, method: string) =>
          tx`INSERT INTO identity_events (id, user_id, event_type, payload) VALUES (${randomUUID()}, ${id}, 'bind', ${tx.json({ method })})`;

        // SIWE (auth.ts:231): wallet_address set, profile, wallet binding.
        await tx`INSERT INTO users (id, wallet_address) VALUES (${ids.siwe}, ${`0x${randomUUID().replace(/-/g, "")}`})`;
        await profile(ids.siwe);
        await binding(ids.siwe, "wallet");
        // OAuth first login (auth.ts:548): no wallet; binding, identity event, profile.
        await tx`INSERT INTO users (id, name) VALUES (${ids.oauth}, 'oauth human')`;
        await binding(ids.oauth, "github");
        await event(ids.oauth, "oauth");
        await profile(ids.oauth);
        // Operator-attested GitHub sign-in (operator-attested-binding.server.ts:130): same traces, different method.
        await tx`INSERT INTO users (id, name) VALUES (${ids.attested}, 'attested human')`;
        await binding(ids.attested, "github");
        await event(ids.attested, "operator_attestation");
        await profile(ids.attested);
        // A registered agent from before registration wrote its principal row: a user and nothing else.
        await tx`INSERT INTO users (id, name) VALUES (${ids.agent}, 'registered agent')`;

        await fn(ids, tx);
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
  };

  const rowsFor = async (tx: TransactionSql, ids: string[]) =>
    tx`SELECT user_id, kind FROM agent_principals WHERE user_id = ANY(${ids}) ORDER BY user_id`;

  it("gives an external row to the registered agent and to no human", async () => {
    await withFixtures(async (ids, tx) => {
      await tx.unsafe(backfill());
      expect(await rowsFor(tx, Object.values(ids))).toEqual([{ user_id: ids.agent, kind: "external" }]);
    });
  });

  it("leaves the system tenant and this node's AI as they were, and a rerun inserts nothing", async () => {
    await withFixtures(async (ids, tx) => {
      await tx.unsafe(backfill());
      await tx.unsafe(backfill());
      expect(await rowsFor(tx, [ids.agent])).toHaveLength(1);
      expect(await rowsFor(tx, [SYSTEM_TENANT_USER_ID])).toEqual([]);
      expect(await rowsFor(tx, [NODE_AI_PRINCIPAL_USER_ID])).toEqual([{ user_id: NODE_AI_PRINCIPAL_USER_ID, kind: "internal" }]);
    });
  });
});
