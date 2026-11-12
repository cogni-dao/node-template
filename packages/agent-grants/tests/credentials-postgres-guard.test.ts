// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * FAIL_CLOSED_ON_WRONG_ROLE and the injected role read, over a recording fake SQL client (no database).
 * Under FORCE RLS with no policy, a role without BYPASSRLS reads zero rows: without the guard, `everConfirmed` would say "never confirmed".
 */

import { describe, expect, it } from "vitest";
import {
  assertV1NotSuperseded,
  type CredentialSql,
  createPostgresCredentialStore,
  formatRevocableKey,
  upgradeSignedKey,
  verifyBearer,
} from "../src/credentials";

function fakeSql(answers: { bypass: unknown; roleQueryFails?: boolean }) {
  const queries: string[] = [];
  const tag = async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text);
    if (text.includes("pg_roles")) {
      if (answers.roleQueryFails) throw new Error("db down");
      return [{ bypass: answers.bypass }];
    }
    if (text.includes("agent_authority_maintenance")) return [{ backfill_ready: true }]; // fully migrated fixture
    return []; // what a non-BYPASSRLS role sees under FORCE RLS with no policy
  };
  const client = Object.assign(tag, { begin: <T>(fn: (tx: typeof tag) => Promise<T>) => fn(tag) });
  return { client: client as unknown as CredentialSql, queries };
}
const noRoles = async () => false;

describe("store role guard", () => {
  it("a role without BYPASSRLS makes every store call unavailable, never 'never confirmed'", async () => {
    const { client, queries } = fakeSql({ bypass: false });
    const store = createPostgresCredentialStore(client, { hasRoles: noRoles });
    await expect(store.everConfirmed("u")).rejects.toThrow(/BYPASSRLS/);
    await expect(assertV1NotSuperseded(store, "u")).rejects.toMatchObject({ code: "authz_unavailable" });
    await expect(upgradeSignedKey(store, { userId: "u" })).rejects.toMatchObject({ code: "authz_unavailable" });
    expect(await verifyBearer(store, formatRevocableKey("a".repeat(43)))).toEqual({ ok: false, reason: "unavailable" });
    expect(queries.every((q) => q.includes("pg_roles"))).toBe(true); // no table read ran
  });

  it("a failing role query is unavailable too", async () => {
    const { client } = fakeSql({ bypass: true, roleQueryFails: true });
    const store = createPostgresCredentialStore(client, { hasRoles: noRoles });
    await expect(assertV1NotSuperseded(store, "u")).rejects.toMatchObject({ code: "authz_unavailable" });
  });

  it("a bypassing (or superuser) role passes, and the check runs once per store instance", async () => {
    const { client, queries } = fakeSql({ bypass: true });
    const store = createPostgresCredentialStore(client, { hasRoles: noRoles });
    await expect(assertV1NotSuperseded(store, "u")).resolves.toBeUndefined();
    await store.everConfirmed("u");
    await store.lookup("h");
    expect(queries.filter((q) => q.includes("pg_roles"))).toHaveLength(1);
    expect(queries.some((q) => q.includes("rolsuper"))).toBe(true);
  });

  it("a throwing hasRoles is an outage at upgrade, never 'no roles'", async () => {
    const { client } = fakeSql({ bypass: true });
    const store = createPostgresCredentialStore(client, {
      hasRoles: async () => {
        throw new Error("openfga down");
      },
    });
    await expect(upgradeSignedKey(store, { userId: "u" })).rejects.toMatchObject({ code: "authz_unavailable" });
  });
});
