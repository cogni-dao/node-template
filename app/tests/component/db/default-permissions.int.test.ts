// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/default-permissions.int.test`
 * Purpose: DEFAULT_PERMISSIONS_ARE_DECLARED (task.5471). The (principal slug, scope) pairs a permission declares with
 *   `requires.onByDefaultFor` must equal the rows migration 0039 wrote with the system principal as approver, on a
 *   database built from every migration. CI fails when a declared default has no migration row, a row names an
 *   undeclared scope, or a declared principal is not seeded. Also proves the migration SQL is once-only: a revoked,
 *   pending or live row for the principal and scope is never overridden, and an unseeded principal aborts it.
 * Scope: The declarations (`CORE_TOOL_BUNDLE`, `ROUTE_ONLY_CAPABILITIES`), a snapshot of `agent_roles` taken by the
 *   global setup right after migrate (before any test file runs), and the 0039 SQL run against throwaway principals.
 * Invariants:
 *   - SNAPSHOT_NOT_LIVE: the shared component database is mutated by parallel files (they revoke and insert rows for
 *     the seeded principals), so the gate reads only the post-migrate snapshot, never live rows of those principals.
 *   - DEFAULT_ROWS_EMIT_NO_LOG: a migration row writes no `agent_role.granted` log; read `agent_roles` to audit it.
 *   - SYSTEM_APPROVER_IS_MIGRATION_ONLY: no runtime source writes `approved_by` = the system principal.
 * Side-effects: IO (testcontainers Postgres, reads source files)
 * Links: app/src/adapters/server/db/migrations/0039_default_permissions.sql, tests/component/setup/testcontainers-postgres.global.ts
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROUTE_ONLY_CAPABILITIES } from "@cogni/agent-grants";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Pair {
  readonly slug: string;
  readonly scope: string;
}
interface Snapshot {
  /** Every agent_roles row as the migrations left it; `bySystem` = approved by the system principal. */
  readonly rows: ReadonlyArray<Pair & { readonly revoked: boolean; readonly bySystem: boolean }>;
  /** Internal principal slugs seeded by the migrations. */
  readonly principals: readonly string[];
}

const MIGRATION = resolve(
  __dirname,
  "../../../src/adapters/server/db/migrations/0039_default_permissions.sql"
);

/** Every declared permission: each tool contract's `requires` plus each route-only capability. */
function declarations() {
  const requires = [
    ...CORE_TOOL_BUNDLE.map((t) => t.contract.requires),
    ...Object.values(ROUTE_ONLY_CAPABILITIES).map((c) => c.requires),
  ].filter((r): r is NonNullable<typeof r> => Boolean(r));
  const scopes = new Set(requires.map((r) => r.scope));
  const pairs: Pair[] = requires.flatMap((r) =>
    (r.onByDefaultFor ?? []).map((slug) => ({ slug, scope: r.scope }))
  );
  return { scopes, pairs };
}

const key = (p: Pair) => `${p.slug} ${p.scope}`;

/** The migration block to commit for a declared default that has no row. */
function renderMissing(p: Pair): string {
  return [
    `-- default-permission: ${p.slug} ${p.scope}`,
    `(copy the DO-block and INSERT for "${p.slug}" / "${p.scope}" from 0039_default_permissions.sql into a NEW migration)`,
  ].join("\n");
}

/** The gate. Returns one message per violation; empty = declarations and migrations agree. */
function checkDefaultPermissions(
  declared: { scopes: ReadonlySet<string>; pairs: readonly Pair[] },
  snapshot: Snapshot
): string[] {
  const problems: string[] = [];
  const system = snapshot.rows.filter((r) => r.bySystem);
  // A default a later migration revoked ("removed default") is no longer written; only live system rows count.
  const written = new Set(system.filter((r) => !r.revoked).map(key));
  for (const p of declared.pairs) {
    if (!snapshot.principals.includes(p.slug))
      problems.push(`unseeded principal: ${key(p)} (seed "${p.slug}" in a migration before the default)`);
    else if (!written.has(key(p)))
      problems.push(`declared default has no migration row: ${key(p)}\n${renderMissing(p)}`);
  }
  const declaredKeys = new Set(declared.pairs.map(key));
  for (const r of snapshot.rows.filter((x) => !x.bySystem))
    problems.push(`install wrote a row the system principal did not approve: ${key(r)}`);
  for (const r of system.filter((x) => !x.revoked)) {
    if (!declared.scopes.has(r.scope))
      problems.push(`migration row names an undeclared scope: ${key(r)}`);
    else if (!declaredKeys.has(key(r)))
      problems.push(
        `migration row is not declared by onByDefaultFor: ${key(r)} (declare it, or revoke it in a new migration)`
      );
  }
  return problems;
}

const readSnapshot = (): Snapshot => {
  const raw = process.env.DEFAULT_PERMISSIONS_SNAPSHOT;
  if (!raw)
    throw new Error(
      "DEFAULT_PERMISSIONS_SNAPSHOT missing: testcontainers-postgres.global.ts must snapshot agent_roles right after migrate"
    );
  return JSON.parse(raw) as Snapshot;
};

describe("default permissions are declared (DEFAULT_PERMISSIONS_ARE_DECLARED)", () => {
  it("the declarations and the migration rows agree on a database built from every migration", () => {
    const declared = declarations();
    // Guard against a vacuous pass: the two defaults this item ships stay declared (a later default adds to the list).
    expect(declared.pairs.map(key)).toEqual(
      expect.arrayContaining(["node-ai schedule:manage", "prioritizer work_item:transition"])
    );
    const snapshot = readSnapshot();
    expect(checkDefaultPermissions(declared, snapshot), "default permission drift").toEqual([]);
  });

  describe("the gate fails on each class of drift (negative controls)", () => {
    const base = { scopes: new Set(["a:one", "b:two"]), pairs: [{ slug: "ai-1", scope: "a:one" }] };
    const snap = (over: Partial<Snapshot>): Snapshot => ({
      rows: [{ slug: "ai-1", scope: "a:one", revoked: false, bySystem: true }],
      principals: ["ai-1"],
      ...over,
    });

    it("passes when they agree", () => {
      expect(checkDefaultPermissions(base, snap({}))).toEqual([]);
    });
    it("fails a declared default with no migration row, and names the block to add", () => {
      const out = checkDefaultPermissions(base, snap({ rows: [] }));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/no migration row: ai-1 a:one/);
      expect(out[0]).toMatch(/-- default-permission: ai-1 a:one/);
    });
    it("fails a migration row that names an undeclared scope", () => {
      const out = checkDefaultPermissions(
        base,
        snap({ rows: [{ slug: "ai-1", scope: "a:one", revoked: false, bySystem: true }, { slug: "ai-1", scope: "x:gone", revoked: false, bySystem: true }] })
      );
      expect(out).toEqual([expect.stringMatching(/undeclared scope: ai-1 x:gone/)]);
    });
    it("fails a migration row for a declared scope that no declaration defaults to that principal", () => {
      const out = checkDefaultPermissions(
        base,
        snap({ rows: [{ slug: "ai-1", scope: "a:one", revoked: false, bySystem: true }, { slug: "ai-1", scope: "b:two", revoked: false, bySystem: true }] })
      );
      expect(out).toEqual([expect.stringMatching(/not declared by onByDefaultFor: ai-1 b:two/)]);
    });
    it("fails an install row an admin-style approver wrote (only migrations write at install)", () => {
      const out = checkDefaultPermissions(
        base,
        snap({ rows: [{ slug: "ai-1", scope: "a:one", revoked: false, bySystem: true }, { slug: "ai-1", scope: "b:two", revoked: false, bySystem: false }] })
      );
      expect(out).toEqual([expect.stringMatching(/did not approve: ai-1 b:two/)]);
    });
    it("fails a declared default for a principal no migration seeds", () => {
      const out = checkDefaultPermissions(base, snap({ principals: [], rows: [] }));
      expect(out).toEqual([expect.stringMatching(/unseeded principal: ai-1 a:one/)]);
    });
  });
});

describe("SYSTEM_APPROVER_IS_MIGRATION_ONLY: no runtime source writes approved_by = the system principal", () => {
  const SRC_ROOTS = [resolve(__dirname, "../../../src"), resolve(__dirname, "../../../../packages")];
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".next" || name === "migrations" || name === "tests") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  };

  it("no runtime source file both names the system principal and writes agent role rows", () => {
    const offenders = SRC_ROOTS.flatMap((root) => walk(root)).filter((file) => {
      const text = readFileSync(file, "utf8");
      const namesSystem =
        text.includes("COGNI_SYSTEM_PRINCIPAL_USER_ID") || text.includes("00000000-0000-4000-a000-000000000001");
      const writesRoles = /approvedBy|approved_by|grantRole|insertRole|approvePending/.test(text);
      return namesSystem && writesRoles;
    });
    expect(offenders).toEqual([]);
  });
});

describe("migration 0039 SQL is once-only (run against throwaway principals)", () => {
  let service: Sql;
  const created = { users: [] as string[] };
  const sqlText = readFileSync(MIGRATION, "utf8");
  // The marker statements (DO-block + INSERT) for the first pair; the ALTER/set_config lines are owner-only and covered
  // by the real migrate that produced the snapshot.
  const statements = sqlText
    .split("--> statement-breakpoint")
    .filter((s) => s.includes("-- default-permission: prioritizer work_item:transition"));

  const run = async (slug: string, scope: string) => {
    for (const s of statements)
      await service.unsafe(s.replaceAll("prioritizer", slug).replaceAll("work_item:transition", scope));
  };
  const principal = async (slug: string) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`dp-${id.slice(0, 6)}`})`;
    await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('internal', ${slug}, ${id})`;
    created.users.push(id);
    return id;
  };
  const rows = (principalId: string, scope: string) =>
    service`SELECT approved_by, granted_at, revoked_at FROM agent_roles WHERE principal_user_id = ${principalId} AND scope = ${scope}`;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    expect(statements).toHaveLength(2); // the DO-block and the INSERT
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });
  afterAll(async () => {
    await service?.unsafe("DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1)", [created.users]);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [created.users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [created.users]);
    await service?.end({ timeout: 1 });
  });

  it("inserts one live row approved by the system principal, and a second run adds nothing", async () => {
    const slug = `t5471-${randomUUID().slice(0, 8)}`;
    const id = await principal(slug);
    await run(slug, "dp:fresh");
    await run(slug, "dp:fresh");
    const r = await rows(id, "dp:fresh");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ approved_by: COGNI_SYSTEM_PRINCIPAL_USER_ID, revoked_at: null });
    expect(r[0]?.granted_at).not.toBeNull();
  });

  it("a pre-revoked row stays revoked: the migration adds no live row (a revoke sticks)", async () => {
    const slug = `t5471-${randomUUID().slice(0, 8)}`;
    const id = await principal(slug);
    const admin = await principal(`t5471-admin-${randomUUID().slice(0, 8)}`);
    await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, revoked_at)
      VALUES (${id}, 'dp:revoked', ${admin}, now(), now())`;
    await run(slug, "dp:revoked");
    const r = await rows(id, "dp:revoked");
    expect(r).toHaveLength(1);
    expect(r[0]?.revoked_at).not.toBeNull();
    expect(r[0]?.approved_by).toBe(admin);
  });

  it("a pending ask or a denied ask is not overridden either", async () => {
    const slug = `t5471-${randomUUID().slice(0, 8)}`;
    const id = await principal(slug);
    try {
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by) VALUES (${id}, 'dp:pending', NULL, ${id})`;
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by, revoked_at) VALUES (${id}, 'dp:denied', NULL, ${id}, now())`;
      await run(slug, "dp:pending");
      await run(slug, "dp:denied");
      expect(await rows(id, "dp:pending")).toEqual([expect.objectContaining({ approved_by: null })]);
      expect(await rows(id, "dp:denied")).toEqual([expect.objectContaining({ approved_by: null })]);
    } finally {
      // A live pending row counts toward the global pending cap another file reads; remove it now, not at afterAll.
      await service`DELETE FROM agent_roles WHERE principal_user_id = ${id}`;
    }
  });

  it("an unseeded principal RAISEs instead of inserting nothing", async () => {
    await expect(run(`ghost-${randomUUID().slice(0, 8)}`, "dp:ghost")).rejects.toThrow(/not seeded/);
  });
});
