// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-adapter-set-priority-rank`
 * Purpose: Drives DoltgresWorkItemAdapter.setPriorityRank() through the full operation-branch + proof path (story.5096).
 * Scope: Stateful fake `Sql`. Does not use a real database; the real-engine lane is app/tests/component/db/doltgres-work-items.int.test.ts.
 * Invariants:
 *   - CAS_ON_REVISION: a matching expectedRevision advances revision by one; a stale one throws WorkItemRevisionConflictError and writes nothing.
 *   - COLLABORATOR_AUTHZ: a principal other than the creator may set priority/rank (patch stays creator-bound).
 *   - NOT_FOUND_TYPED: a missing id throws WorkItemNotFoundError before any branch exists.
 * Side-effects: none
 * Links: story.5096, packages/work-items/src/adapters/doltgres/adapter.ts
 * @internal
 */

import { toWorkItemId } from "@cogni-dao/work-items";
import { describe, expect, it } from "vitest";

import {
  DoltgresWorkItemAdapter,
  WorkItemAuthorizationError,
  WorkItemNotFoundError,
  WorkItemRevisionConflictError,
} from "../../src/adapters/doltgres/adapter.js";
import { makeFakeDoltgresSql } from "./fake-doltgres-sql.js";

const ID = "task.0001";
const CREATOR = "principal-creator";
const PRIORITIZER = "system-prioritizer";

const seedRow = {
  id: ID,
  type: "task",
  title: "reprioritize me",
  status: "needs_implement",
  node: "operator",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  priority: 2,
  rank: 7,
  revision: 3,
  deploy_verified: false,
  created_by_principal_id: CREATOR,
  claimed_by_run: null,
  claimed_at: null,
  claim_owner_principal_id: null,
  claim_expires_at: null,
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
};

/**
 * One in-memory row behind the shared Dolt fake. The UPDATE arm honours the
 * statement's own `revision = N` predicate, so the CAS is exercised as SQL, not
 * assumed. `concurrentBumpBeforeUpdate` models a writer outside this adapter's
 * lock landing between preflight and UPDATE.
 */
function harness(options: { concurrentBumpBeforeUpdate?: boolean } = {}) {
  const queries: string[] = [];
  const store = new Map<string, Record<string, unknown>>([
    [ID, { ...seedRow }],
  ]);
  const respond = (query: string) => {
    if (query.startsWith("SELECT id FROM work_items")) return [];
    if (query.startsWith("UPDATE work_items")) {
      const id = /WHERE id = '([^']+)'/.exec(query)?.[1] ?? "";
      const expected = Number(/AND revision = (\d+)/.exec(query)?.[1]);
      const current = store.get(id);
      if (current && options.concurrentBumpBeforeUpdate) {
        current.revision = Number(current.revision) + 1;
      }
      if (!current || Number(current.revision) !== expected) return [];
      const rank = /\brank = (NULL|-?\d+)/.exec(query)?.[1];
      const next = {
        ...current,
        priority: Number(/\bpriority = (-?\d+)/.exec(query)?.[1]),
        rank: rank === "NULL" ? null : Number(rank),
        revision: expected + 1,
        claim_active: false,
      };
      store.set(id, next);
      return [next];
    }
    const byId = /FROM work_items WHERE id = '([^']+)'/.exec(query)?.[1];
    if (byId) {
      const row = store.get(byId);
      return row ? [{ ...row, claim_active: false }] : [];
    }
    return [];
  };
  const sql = makeFakeDoltgresSql(respond, queries);
  const adapter = new DoltgresWorkItemAdapter(sql, {
    readClient: sql,
    recreateClient: () => sql,
  });
  return { adapter, queries, store };
}

const branchCreated = (queries: string[]) =>
  queries.some((query) => query.includes("dolt_checkout('-b'"));
const committed = (queries: string[]) =>
  queries.some((query) => query.startsWith("SELECT dolt_commit"));
const updated = (queries: string[]) =>
  queries.some((query) => query.startsWith("UPDATE work_items"));

describe("DoltgresWorkItemAdapter.setPriorityRank", () => {
  it("applies priority + rank and advances revision by exactly one", async () => {
    const { adapter, queries } = harness();

    const result = await adapter.setPriorityRank(
      { id: toWorkItemId(ID), expectedRevision: 3, priority: 0, rank: 1 },
      CREATOR
    );

    expect(result).toMatchObject({ id: ID, priority: 0, rank: 1, revision: 4 });
    const update = queries.find((query) => query.startsWith("UPDATE work_items"));
    expect(update).toContain(
      "SET priority = 0, rank = 1, revision = revision + 1, updated_at = NOW()"
    );
    // CAS is in the statement itself, not only in the preflight.
    expect(update).toContain(`WHERE id = '${ID}' AND revision = 3`);
    // An attributable Dolt commit, merged through the normal proof path.
    expect(queries).toContain(
      `SELECT dolt_commit('-m', 'work-items: set-priority-rank ${ID} by actor:${CREATOR}')`
    );
    expect(queries.some((query) => query.includes("FROM dolt_merge("))).toBe(
      true
    );
  });

  it("refuses a stale expectedRevision before any branch or DML, leaving the row unchanged", async () => {
    const { adapter, queries, store } = harness();

    const attempt = adapter.setPriorityRank(
      { id: toWorkItemId(ID), expectedRevision: 2, priority: 0, rank: 1 },
      CREATOR
    );

    await expect(attempt).rejects.toBeInstanceOf(WorkItemRevisionConflictError);
    await expect(attempt).rejects.toMatchObject({
      id: ID,
      expectedRevision: 2,
      currentRevision: 3,
    });
    expect(branchCreated(queries)).toBe(false);
    expect(updated(queries)).toBe(false);
    expect(store.get(ID)).toMatchObject({ priority: 2, rank: 7, revision: 3 });
  });

  it("reports a conflict, commits nothing, and drops the branch when the UPDATE loses a race", async () => {
    const { adapter, queries, store } = harness({
      concurrentBumpBeforeUpdate: true,
    });

    await expect(
      adapter.setPriorityRank(
        { id: toWorkItemId(ID), expectedRevision: 3, priority: 0, rank: 1 },
        CREATOR
      )
    ).rejects.toMatchObject({
      name: "WorkItemRevisionConflictError",
      expectedRevision: 3,
      currentRevision: 4,
    });
    expect(committed(queries)).toBe(false);
    expect(
      queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(true);
    expect(store.get(ID)).toMatchObject({ priority: 2, rank: 7 });
  });

  it("lets a non-creator principal set priority/rank while patch stays creator-bound", async () => {
    const { adapter, queries } = harness();

    await expect(
      adapter.setPriorityRank(
        { id: toWorkItemId(ID), expectedRevision: 3, priority: 1, rank: null },
        PRIORITIZER
      )
    ).resolves.toMatchObject({ id: ID, priority: 1, revision: 4 });

    const update = queries.find((query) => query.startsWith("UPDATE work_items"));
    expect(update).toContain("rank = NULL");
    expect(update).not.toContain("created_by_principal_id");
    expect(queries).toContain(
      `SELECT dolt_commit('-m', 'work-items: set-priority-rank ${ID} by actor:${PRIORITIZER}')`
    );

    // Non-vacuous: the collaboration grant is scoped to this op only.
    await expect(
      adapter.patch({ id: toWorkItemId(ID), set: { title: "not yours" } }, PRIORITIZER)
    ).rejects.toBeInstanceOf(WorkItemAuthorizationError);
  });

  it("throws WorkItemNotFoundError for a missing id before any branch exists", async () => {
    const { adapter, queries } = harness();

    const attempt = adapter.setPriorityRank(
      { id: toWorkItemId("task.9999"), expectedRevision: 0, priority: 0, rank: 1 },
      PRIORITIZER
    );

    await expect(attempt).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(attempt).rejects.toThrow(/Work item not found: task\.9999/);
    expect(branchCreated(queries)).toBe(false);
  });

  it("rejects malformed input and an anonymous principal without touching the store", async () => {
    const { adapter, queries } = harness();
    const id = toWorkItemId(ID);

    await expect(
      adapter.setPriorityRank({ id, expectedRevision: 3, priority: 1.5, rank: 1 }, CREATOR)
    ).rejects.toThrow(/priority/);
    await expect(
      adapter.setPriorityRank({ id, expectedRevision: "abc", priority: 1, rank: 1 }, CREATOR)
    ).rejects.toThrow(/expectedRevision/);
    await expect(
      adapter.setPriorityRank({ id, expectedRevision: 3, priority: 1, rank: 1 }, "  ")
    ).rejects.toBeInstanceOf(WorkItemAuthorizationError);
    expect(queries).toHaveLength(0);
  });
});
