// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** CI-only independent consumer: documented host prerequisites plus package-shipped templates; no node app migrations/seeds. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

const stages = ["agent_authority", "agent_credentials", "agent_service_enrollments", "agent_service_enrollment_maintenance", "agent_authority_foundation", "agent_authority_guard_compatibility", "agent_authority_review_repairs", "agent_authority_maintenance_cursor", "agent_authority_v2_reader", "agent_authority_consent_control"] as const;

export async function startAgentGrantsAdopter(repairs = true, beforeFoundation?: (db: Sql) => Promise<void>) {
  const container = await new PostgreSqlContainer("postgres:15-alpine").start();
  const admin = postgres(container.getConnectionUri(), { max: 3 });
  const directory = await mkdtemp(join(tmpdir(), "agent-grants-adopter-"));
  const uri = new URL(container.getConnectionUri());
  await admin.unsafe("CREATE ROLE adopter_owner LOGIN PASSWORD 'fixture_owner_only' NOSUPERUSER NOBYPASSRLS");
  await admin.unsafe("CREATE ROLE adopter_app LOGIN PASSWORD 'fixture_app_only' NOSUPERUSER NOBYPASSRLS");
  await admin.unsafe("CREATE ROLE adopter_service LOGIN PASSWORD 'fixture_service_only' NOSUPERUSER BYPASSRLS");
  await admin`GRANT CREATE ON DATABASE ${admin(container.getDatabase())} TO adopter_owner`;
  await admin.unsafe("GRANT USAGE, CREATE ON SCHEMA public TO adopter_owner");
  uri.username = "adopter_owner"; uri.password = "fixture_owner_only";
  const owner = postgres(uri.toString(), { max: 1 });
  uri.username = "adopter_service"; uri.password = "fixture_service_only";
  const serviceUrl = uri.toString();
  const service = postgres(serviceUrl, { max: 8 });
  uri.username = "adopter_app"; uri.password = "fixture_app_only";
  const app = postgres(uri.toString(), { max: 2 });
  await mkdir(join(directory, "meta"));
  await writeFile(join(directory, "0000_host.sql"), `CREATE TABLE users (id text PRIMARY KEY, name text, wallet_address text);
--> statement-breakpoint
CREATE TABLE user_bindings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL REFERENCES users(id), provider text NOT NULL, external_id text NOT NULL);`);
  const apply = async (count: number) => {
    const selected = stages.slice(0, count);
    const entries = [{ idx: 0, version: "7", when: 1000, tag: "0000_host", breakpoints: true }];
    for (const [offset, stage] of selected.entries()) {
      const idx = offset + 1;
      const tag = `${String(idx).padStart(4, "0")}_${stage}`;
      await writeFile(join(directory, `${tag}.sql`), await readFile(resolve(`../packages/agent-grants/migrations/${stage}.sql`), "utf8"));
      entries.push({ idx, version: "7", when: 1000 + idx, tag, breakpoints: true });
    }
    await writeFile(join(directory, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
    await migrate(drizzle(owner), { migrationsFolder: directory });
    await admin.unsafe("GRANT USAGE ON SCHEMA public TO adopter_app, adopter_service");
    await admin.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO adopter_app, adopter_service");
  };
  try {
    if (beforeFoundation) { await apply(4); await beforeFoundation(admin); }
    await apply(repairs ? stages.length : stages.length - 4);
  }
  catch (error) { await owner.end(); await app.end(); await service.end(); await admin.end(); await container.stop(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    service, app, serviceUrl, owner, admin,
    applyRepairs: () => apply(stages.length),
    async close() { await owner.end(); await app.end(); await service.end(); await admin.end(); await container.stop(); await rm(directory, { recursive: true, force: true }); },
  };
}
