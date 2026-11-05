// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * bug.0013: `reassignCreator` moves every row of one creator to another in ONE
 * proven Dolt commit, bumping each revision exactly as `patch` does. The
 * multi-row branch proof must refuse any diff that changes another column.
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresWorkItemAdapter } from "../../src/adapters/doltgres/adapter.js";
import {
  independentReadPool,
  makeFakeDoltgresSql,
} from "./fake-doltgres-sql.js";

type Row = Record<string, unknown>;

const OLD = "d21ba072-e928-4653-bf22-ba83972453cf";
const NEW = "52d379aa-e925-4da9-8e6b-2fd62e8a10d0";
const OTHER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function seed(): Row[] {
  const base = {
    type: "task",
    status: "needs_implement",
    node: "shared",
    assignees: [],
    external_refs: [],
    labels: [],
    spec_refs: [],
    deploy_verified: false,
    claimed_by_run: null,
    claim_owner_principal_id: null,
    claimed_at: null,
    claim_expires_at: null,
    created_at: "2026-10-02T00:00:00.000Z",
    updated_at: "2026-10-02T00:00:00.000Z",
  };
  return [
    { ...base, id: "task.0036", title: "a", revision: 3 },
    { ...base, id: "bug.0011", title: "b", revision: 0 },
    { ...base, id: "task.0099", title: "c", revision: 5 },
  ].map((row, index) => ({
    ...row,
    created_by_principal_id: index < 2 ? OLD : OTHER,
  }));
}

/**
 * The shared fake models one-row operations; this wrapper owns the multi-row
 * table, UPDATE, per-row diff and post-merge read, delegating every protocol
 * query (lock, branch, commit, merge, cleanup) to the shared fake.
 */
function harness(options: { tamperDiff?: boolean } = {}) {
  const queries: string[] = [];
  const table = seed();
  let diffs: Row[] = [];
  const inner = makeFakeDoltgresSql(() => [], queries);
  const prefixed = (prefix: string, row: Row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [`${prefix}${k}`, v])
    );
  const unsafe = async (query: string): Promise<Row[]> => {
    const match = /WHERE created_by_principal_id = '([^']+)'/.exec(query);
    if (query.startsWith("UPDATE work_items") && match) {
      queries.push(query);
      const to = /SET created_by_principal_id = '([^']+)'/.exec(query)?.[1];
      diffs = [];
      const moved: Row[] = [];
      for (const [index, row] of table.entries()) {
        if (row.created_by_principal_id !== match[1]) continue;
        const after = {
          ...row,
          created_by_principal_id: to,
          revision: Number(row.revision) + 1,
          updated_at: "2026-10-03T00:00:30.000Z",
          ...(options.tamperDiff ? { title: "smuggled" } : {}),
        };
        diffs.push({
          ...prefixed("from_", row),
          ...prefixed("to_", after),
          diff_type: "modified",
        });
        table[index] = after;
        moved.push({ id: after.id });
      }
      return moved;
    }
    if (query.startsWith("SELECT id FROM work_items WHERE") && match) {
      queries.push(query);
      return table
        .filter((row) => row.created_by_principal_id === match[1])
        .map((row) => ({ id: row.id }));
    }
    if (query.startsWith("SELECT * FROM dolt_diff(")) {
      queries.push(query);
      return diffs;
    }
    if (query.startsWith("SELECT * FROM work_items WHERE id IN (")) {
      queries.push(query);
      const ids = [...query.matchAll(/'([^']+)'/g)].map(([, id]) => id);
      return table.filter((row) => ids.includes(String(row.id)));
    }
    return [...(await inner.unsafe(query))];
  };
  const sql = {
    unsafe,
    reserve: async () => ({ unsafe, release: () => undefined }),
    end: async () => undefined,
  } as unknown as Sql;
  const adapter = new DoltgresWorkItemAdapter(sql, {
    readClient: independentReadPool(sql),
    recreateClient: () => sql,
  });
  return { adapter, queries, table };
}

const commits = (queries: string[]) =>
  queries.filter((q) => q.startsWith("SELECT dolt_commit"));
const merges = (queries: string[]) =>
  queries.filter((q) => q.includes("FROM dolt_merge("));

describe("DoltgresWorkItemAdapter.reassignCreator (bug.0013)", () => {
  it("moves every matching row in one proven commit and bumps each revision", async () => {
    const { adapter, queries, table } = harness();

    const result = await adapter.reassignCreator({
      fromPrincipalId: OLD,
      toPrincipalId: NEW,
      actorPrincipalId: ADMIN,
    });

    expect(result).toEqual({ ids: ["bug.0011", "task.0036"] });
    expect(commits(queries)).toHaveLength(1);
    expect(commits(queries)[0]).toContain(
      `work-items: reassign-creator ${OLD} to ${NEW} by actor:${ADMIN}`
    );
    expect(merges(queries)).toHaveLength(1);
    expect(queries.find((q) => q.startsWith("UPDATE work_items"))).toContain(
      "revision = revision + 1"
    );
    const byId = Object.fromEntries(table.map((row) => [row.id, row]));
    expect(byId["task.0036"]).toMatchObject({
      created_by_principal_id: NEW,
      revision: 4,
    });
    expect(byId["bug.0011"]).toMatchObject({
      created_by_principal_id: NEW,
      revision: 1,
    });
    expect(byId["task.0099"]).toMatchObject({
      created_by_principal_id: OTHER,
      revision: 5,
    });
  });

  it("dryRun lists the matching ids and writes nothing", async () => {
    const { adapter, queries, table } = harness();

    const result = await adapter.reassignCreator({
      fromPrincipalId: OLD,
      toPrincipalId: NEW,
      actorPrincipalId: ADMIN,
      dryRun: true,
    });

    expect(result).toEqual({ ids: ["bug.0011", "task.0036"] });
    expect(queries.some((q) => q.startsWith("UPDATE"))).toBe(false);
    expect(queries.some((q) => q.includes("dolt_checkout('-b'"))).toBe(false);
    expect(commits(queries)).toHaveLength(0);
    expect(
      table.filter((row) => row.created_by_principal_id === OLD)
    ).toHaveLength(2);
  });

  it("commits nothing when no row matches", async () => {
    const { adapter, queries } = harness();

    const result = await adapter.reassignCreator({
      fromPrincipalId: "22222222-2222-4222-8222-222222222222",
      toPrincipalId: NEW,
      actorPrincipalId: ADMIN,
    });

    expect(result).toEqual({ ids: [] });
    expect(commits(queries)).toHaveLength(0);
    expect(merges(queries)).toHaveLength(0);
  });

  it("refuses from === to before touching the store", async () => {
    const { adapter, queries } = harness();

    await expect(
      adapter.reassignCreator({
        fromPrincipalId: OLD,
        toPrincipalId: OLD,
        actorPrincipalId: ADMIN,
      })
    ).rejects.toThrow(/must differ/);
    expect(queries).toHaveLength(0);
  });

  it("never merges a branch whose diff changes any column beyond creator/revision/updated_at", async () => {
    const { adapter, queries } = harness({ tamperDiff: true });

    await expect(
      adapter.reassignCreator({
        fromPrincipalId: OLD,
        toPrincipalId: NEW,
        actorPrincipalId: ADMIN,
      })
    ).rejects.toMatchObject({ name: "WorkItemWriteOutcomeUnknownError" });
    // Committed-but-unprovable: the branch is preserved for inspection.
    expect(merges(queries)).toHaveLength(0);
  });
});
