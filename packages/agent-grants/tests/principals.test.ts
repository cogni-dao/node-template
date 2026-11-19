// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/principals`
 * Purpose: The one classifier of a write's actor answers each class from the rows alone (hub activity-attribution, task.0133).
 * Scope: `classifyPrincipal` over a fake tagged-template client holding `agent_principals` and `users` rows. No database.
 * Invariants:
 *   - KIND_IS_THE_ROW: internal and external come from the `agent_principals` row; human only when a `users` row exists.
 *   - SYSTEM_IS_NAMED_BY_THE_HOST: a listed system user id is `system` whatever the rows say.
 *   - NOTHING_IS_GUESSED: an id with no row anywhere is `unclassified`, never `human`.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";

import { classifyPrincipal, type SqlTag } from "../src/index";

const SYSTEM = "00000000-0000-4000-a000-000000000001";

/** A client over two tables: it answers by the table the statement names. */
function clientWith(rows: { principals?: Record<string, "internal" | "external" | "org">; users?: string[] }): {
  sql: SqlTag;
  statements: string[];
} {
  const statements: string[] = [];
  const sql: SqlTag = async (strings, ...values) => {
    const text = strings.join("?");
    statements.push(text);
    const id = String(values[0]);
    if (text.includes("FROM agent_principals")) {
      const kind = rows.principals?.[id];
      return kind ? [{ kind }] : [];
    }
    if (text.includes("FROM users")) return rows.users?.includes(id) ? [{ present: 1 }] : [];
    throw new Error(`unexpected statement: ${text}`);
  };
  return { sql, statements };
}

describe("classifyPrincipal (task.0133)", () => {
  const { sql } = clientWith({
    principals: { "node-ai": "internal", "outside-ai": "external", "an-org": "org", [SYSTEM]: "internal" },
    users: ["node-ai", "outside-ai", "an-org", "person", SYSTEM],
  });
  const classify = (id: string) => classifyPrincipal(sql, id, [SYSTEM]);

  it("internal: a node AI's principal row", async () => {
    expect(await classify("node-ai")).toBe("internal");
  });
  it("external: an outside AI's principal row", async () => {
    expect(await classify("outside-ai")).toBe("external");
  });
  it("human: a user with no principal row", async () => {
    expect(await classify("person")).toBe("human");
  });
  it("system: the host-named system principal, whatever its rows say, with no read", async () => {
    const quiet = clientWith({});
    expect(await classifyPrincipal(quiet.sql, SYSTEM, [SYSTEM])).toBe("system");
    expect(quiet.statements).toEqual([]);
    expect(await classify(SYSTEM)).toBe("system");
  });
  it("unclassified: an id with neither a principal row nor a user row", async () => {
    expect(await classify("ghost")).toBe("unclassified");
  });
  it("unclassified: an org's principal row (an org never acts, and is not a person)", async () => {
    expect(await classify("an-org")).toBe("unclassified");
  });
  it("a system list that names nobody classifies the system id from its rows", async () => {
    expect(await classifyPrincipal(sql, SYSTEM, [])).toBe("internal");
  });
});
