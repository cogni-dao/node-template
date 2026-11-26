// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/schema`
 * Purpose: The schema factory builds the three authority tables over a node's own reference tables, and the seed SQL matches the exported principals (task.0175).
 * Scope: Pure definitions and a text check of `migrations/agent_authority.sql`. No database.
 * Side-effects: reads one SQL file
 * @internal
 */

import { readFileSync } from "node:fs";
import { getTableConfig, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { INTERNAL_AGENT_PRINCIPALS } from "../src/internal-principals";
import { defineAgentAuthoritySchema } from "../src/schema";

const users = pgTable("users", { id: text("id").primaryKey() });
const billingAccounts = pgTable("billing_accounts", { id: text("id").primaryKey() });

describe("defineAgentAuthoritySchema", () => {
  const schema = defineAgentAuthoritySchema({ users, billingAccounts });

  it("names the three tables and enables row-level security on each", () => {
    expect(getTableConfig(schema.agentPrincipals).name).toBe("agent_principals");
    expect(getTableConfig(schema.agentRoles).name).toBe("agent_roles");
    expect(getTableConfig(schema.agentCredentials).name).toBe("agent_credentials");
    for (const table of Object.values(schema)) expect(getTableConfig(table).enableRLS).toBe(true);
  });

  it("points its foreign keys at the node's own tables", () => {
    const targets = (table: (typeof schema)[keyof typeof schema]) =>
      getTableConfig(table).foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name);
    expect(targets(schema.agentPrincipals)).toEqual(["users"]);
    expect(new Set(targets(schema.agentRoles))).toEqual(new Set(["users", "billing_accounts"]));
  });
});

describe("agent_authority.sql seed", () => {
  const sqlText = readFileSync(new URL("../migrations/agent_authority.sql", import.meta.url), "utf8");
  it("seeds exactly the exported internal principals", () => {
    for (const { slug, userId } of INTERNAL_AGENT_PRINCIPALS) {
      expect(sqlText).toContain(`VALUES ('internal', '${slug}', '${userId}')`);
      expect(sqlText).toContain(`VALUES ('${userId}', '${slug}', NULL)`);
    }
  });
});
