// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/payout-seed-0045.int.test`
 * Purpose: The 0045 one-time seed against real Postgres. The defect it guards: at cutover every existing human payee silently becomes held because `payout_addresses`
 *   starts empty. A human with exactly one wallet binding keeps being paid there; an ambiguous or agent-owned binding is never seeded.
 * Scope: Runs the migration file's own seed INSERT (not a copy) over fixtures, inside a transaction that is rolled back so no row leaks to other tests.
 * Invariants: AUTH_IS_NOT_PAYMENT (a setting copied once, never a runtime read); PRECISION_OVER_COVERAGE (several bindings stay unseeded).
 * Side-effects: IO (testcontainers Postgres, rolled back)
 * Notes: DATABASE_SERVICE_URL = BYPASSRLS, so the migration's FORCE-RLS lifts are not needed here.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = resolve(__dirname, "../../../src/adapters/server/db/migrations/0045_payout_is_its_own_config.sql");
const ROLLBACK = new Error("rollback");

const seed = (): string => {
  const statement = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .find((part) => /INSERT INTO "payout_addresses"/.test(part));
  if (!statement) throw new Error("0045 has no payout_addresses seed");
  return statement.replace(/^\s*--.*$/gm, "").trim();
};

describe("0045 payout seed (real Postgres)", () => {
  let service: Sql;
  const hex = () => `0x${randomUUID().replaceAll("-", "").padEnd(40, "a").slice(0, 40)}`;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });
  afterAll(async () => {
    await service?.end({ timeout: 1 });
  });

  it("copies a human's single wallet binding (lowercased) and nothing ambiguous or agent-owned", async () => {
    const mixed = `0x${"AbCdEf".repeat(6)}${"12".repeat(2)}`;
    const ids = { one: randomUUID(), two: randomUUID(), agent: randomUUID(), zero: randomUUID() };
    let seeded: Array<{ user_id: string; address: string }> = [];

    await service
      .begin(async (tx) => {
        for (const id of Object.values(ids)) await tx`INSERT INTO users (id, name) VALUES (${id}, ${`t-${id.slice(0, 6)}`})`;
        const bind = (user: string, wallet: string) =>
          tx`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${user}, 'wallet', ${wallet})`;
        await bind(ids.one, mixed);
        await bind(ids.two, hex());
        await bind(ids.two, hex());
        await bind(ids.agent, hex());
        await tx`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('external', NULL, ${ids.agent})`;
        await bind(ids.zero, `0x${"0".repeat(40)}`);

        await tx.unsafe(seed());

        seeded = await tx`SELECT user_id, address FROM payout_addresses WHERE user_id = ANY(${Object.values(ids)})`;
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });

    expect(seeded).toEqual([{ user_id: ids.one, address: mixed.toLowerCase() }]);
  });
});
