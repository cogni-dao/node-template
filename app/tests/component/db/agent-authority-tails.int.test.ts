// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-authority-tails.int`
 * Purpose: A fresh node applies `defineAgentAuthoritySchema` plus the package's SQL tails and gets every guard object (task.0175). The factory and the tails cannot drift apart unseen:
 *   this test generates the migration from the factory on an EMPTY schema (the way a node's `db:generate` does), appends the tails in the README's order, and asserts success.
 * Scope: `@cogni-dao/agent-grants/schema` + `migrations/{agent_authority,agent_account_grants,agent_credentials}.sql`, over real Postgres as the app role (the DB owner). No HTTP, no app code.
 * Invariants:
 *   - FRESH_DATABASE: the migration runs in its own schema (the app role cannot create databases); `public.` references are rewritten to it. Nothing here touches the node's own tables.
 *   - GUARD_OBJECTS_EXIST: FORCE row-level security on the three tables, `agent_credential_state`, `agent_credentials_require_external_principal` and its trigger, `agent_has_scope`, both select policies and the two seeded principals.
 * Side-effects: IO (testcontainers Postgres; creates and drops one schema)
 * Links: packages/agent-grants/migrations/README.md
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { defineAgentAuthoritySchema } from "@cogni/agent-grants/schema";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { pgTable, text } from "drizzle-orm/pg-core";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  walletAddress: text("wallet_address"),
});
const billingAccounts = pgTable("billing_accounts", { id: text("id").primaryKey() });

const MIGRATIONS = path.resolve(path.dirname(createRequire(import.meta.url).resolve("@cogni/agent-grants")), "../migrations");
// The README's order: base tails first (the credentials trigger reads agent_principals).
const TAILS = ["agent_authority.sql", "agent_account_grants.sql", "agent_credentials.sql"] as const;

const statementsOf = (sqlText: string): string[] =>
  sqlText
    .split("--> statement-breakpoint")
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((statement) => statement.length > 0);

describe("agent authority: the factory plus the SQL tails on a fresh database", () => {
  const schema = `tails_${randomBytes(4).toString("hex")}`;
  let app: Sql;
  const scoped = (statement: string) =>
    statement
      .replace(/"public"\./g, `"${schema}".`)
      .replace(/(?<![\w"])public\./g, `${schema}.`)
      .replace(/pg_catalog, public/g, `pg_catalog, ${schema}`);

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("component PostgreSQL required");
    app = postgres(process.env.DATABASE_URL, { max: 1 });
    await app.unsafe(`CREATE SCHEMA ${schema}`);
    const tables = defineAgentAuthoritySchema({ users, billingAccounts });
    const generated = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({ users, billingAccounts, ...tables })
    );
    const tails = TAILS.flatMap((file) => statementsOf(readFileSync(path.join(MIGRATIONS, file), "utf8")));
    await app.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path = ${schema}`);
      for (const statement of [...generated, ...tails]) await tx.unsafe(scoped(statement));
    });
  });

  afterAll(async () => {
    if (!app) return;
    await app.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await app.end({ timeout: 1 });
  });

  it("forces row-level security on the three authority tables", async () => {
    const rows = await app`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname IN ('agent_principals', 'agent_roles', 'agent_credentials')
      ORDER BY c.relname`;
    expect(rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity])).toEqual([
      ["agent_credentials", true, true],
      ["agent_principals", true, true],
      ["agent_roles", true, true],
    ]);
  });

  it("installs the functions, the credentials trigger and both select policies", async () => {
    const fns = await app`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ${schema} ORDER BY p.proname`;
    expect(fns.map((r) => r.proname)).toEqual([
      "agent_credential_state",
      "agent_credentials_require_external_principal",
      "agent_has_scope",
    ]);
    const triggers = await app`
      SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND NOT t.tgisinternal`;
    expect(triggers.map((r) => r.tgname)).toEqual(["agent_credentials_external_principal_only"]);
    const policies = await app`SELECT policyname FROM pg_policies WHERE schemaname = ${schema} ORDER BY policyname`;
    expect(policies.map((r) => r.policyname)).toEqual(["agent_principals_read", "agent_roles_account_self_read"]);
  });

  it("seeds node-ai and prioritizer as internal principals with no credential", async () => {
    const rows = await app.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path = ${schema}`);
      await tx`SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0001', true)`;
      return tx`SELECT kind, slug FROM agent_principals ORDER BY slug`;
    });
    expect(rows.map((r) => [r.kind, r.slug])).toEqual([
      ["internal", "node-ai"],
      ["internal", "prioritizer"],
    ]);
  });

  it("refuses a credential for an internal principal (the trigger fires before row-level security)", async () => {
    await expect(
      app.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path = ${schema}`);
        await tx`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES ('00000000-0000-4000-a000-0000000a0001', 'h', 'rotation', now() + interval '1 day', now() + interval '2 days')`;
      })
    ).rejects.toMatchObject({ code: "23514" });
  });
});
