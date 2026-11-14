// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/migration-role`
 * Purpose: Migration 0041 grants `agent_roles` SELECT and `agent_has_scope` EXECUTE `TO CURRENT_USER`. That is the app role only while the MIGRATING role
 *   equals the RUNTIME role: the initContainer (`scripts/db/migrate.mjs`) must connect with `DATABASE_URL`, the URL the app's RLS-subject client uses, and
 *   never with the service role's `DATABASE_SERVICE_URL`. This test fails if either side moves. (The component suite checks the same on a live cluster:
 *   the owner of the table is the app connection's role.)
 * Scope: Reads three source files. No database.
 * Invariants: MIGRATOR_IS_APP_ROLE.
 * Side-effects: filesystem reads
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

describe("migrator role equals runtime role (migration 0041 grants to CURRENT_USER)", () => {
  it("the migrator connects with DATABASE_URL and never the service URL", () => {
    const migrate = code(read("scripts/db/migrate.mjs"));
    expect(migrate).toContain("process.env.DATABASE_URL");
    expect(migrate).not.toContain("DATABASE_SERVICE_URL");
  });

  it("the app's RLS-subject client uses that same DATABASE_URL, and the service client is the other URL", () => {
    expect(code(read("app/src/adapters/server/db/drizzle.client.ts"))).toContain("env.DATABASE_URL");
    expect(code(read("app/src/adapters/server/db/drizzle.client.ts"))).not.toContain("DATABASE_SERVICE_URL");
    expect(code(read("app/src/adapters/server/db/drizzle.service-client.ts"))).toContain("env.DATABASE_SERVICE_URL");
  });

  it("the migration states the assumption and cites the migrator, and the image runs that migrator", () => {
    const sql = read("app/src/adapters/server/db/migrations/0041_agent_account_grants.sql");
    expect(sql).toContain("GRANT SELECT ON \"agent_roles\" TO CURRENT_USER");
    expect(sql).toContain("scripts/db/migrate.mjs");
    expect(sql).toContain("DATABASE_URL");
    expect(read("Dockerfile")).toContain("scripts/db/migrate.mjs");
  });
});
