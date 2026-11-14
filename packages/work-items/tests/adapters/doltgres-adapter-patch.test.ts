// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-adapter-patch`
 * Purpose: Drives DoltgresWorkItemAdapter.patch() so deploy_verified, project_id, parent_id and blocked_by provably reach the UPDATE (bug.5005).
 * Scope: Fake `Sql` capturing emitted UPDATE text. Does not use a real database and does not assert read-back behaviour.
 * Invariants:
 *   - PATCH_DEPLOY_VERIFIED: deployVerified:true emits `deploy_verified = TRUE`.
 *   - PATCH_NULLABLE_CLEAR: projectId:null emits `project_id = NULL`.
 *   - PATCH_PRESERVES_EXISTING: title still emits `title = '...'`.
 *   - PATCH_CAS (task.5284): expectedRevision is in the UPDATE predicate; a stale one throws WorkItemRevisionConflictError with nothing committed.
 *   - AUTHORITY_IS_NOT_KIND (bug.0019): the adapter never gates patch on creator equality; a principal that did not create the row may patch any field (the door's authorize() decided), and the creator column stays immutable.
 *   - SCORES_JSONB_ORDER (story.5111): a scores patch is proven even when jsonb reorders its keys.
 *   - SCORES_BOUNDS_IN_PACKAGE (story.5111): create/patch run parseWorkItemScores; invalid scores never reach SQL.
 *   - REASON_REQUIRED (task.0086): a patch without a valid reason fails before any SQL; the reason is the commit's `Reason:` line.
 *   - CITES_PINNED (task.0086): the resolver runs inside the writer lock, before the branch, within one deadline; a failure releases the lock and writes nothing; the `Cites:` line holds only validated pins.
 * Side-effects: none
 * Links: bug.5005, task.5284,
 *   packages/work-items/src/adapters/doltgres/adapter.ts
 * @internal
 */

import { toWorkItemId } from "@cogni-dao/work-items";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  DoltgresWorkItemAdapter,
  type DoltgresWorkItemAdapterOptions,
  WorkItemAuthorizationError,
  WorkItemRevisionConflictError,
} from "../../src/adapters/doltgres/adapter.js";
import {
  CitesInvalidError,
  CitesUnsupportedError,
  type EntryResolver,
  EntryResolverUnavailableError,
  EntryUnresolvedError,
} from "../../src/cites.js";
import { WorkItemScoresInvalidError } from "../../src/errors.js";
import {
  CHANGE_REASON_REQUIRED_MESSAGE,
  ChangeReasonInvalidError,
} from "../../src/history.js";
import {
  independentReadPool,
  makeFakeDoltgresSql,
} from "./fake-doltgres-sql.js";

function makeFakeSql(): { sql: Sql; queries: string[] } {
  const queries: string[] = [];
  const respond = (q: string): unknown[] => {
    if (q.startsWith("UPDATE work_items")) {
      const title = /title = '([^']*)'/.exec(q)?.[1] ?? "t";
      return [
        {
          id: "bug.5005",
          type: "bug",
          title,
          status: "needs_implement",
          node: "operator",
          actor: "either",
          assignees: [],
          external_refs: [],
          labels: [],
          spec_refs: [],
          revision: 0,
          deploy_verified: q.includes("deploy_verified = TRUE"),
          project_id: q.includes("project_id = NULL") ? null : undefined,
          parent_id: /parent_id = '([^']*)'/.exec(q)?.[1] ?? undefined,
          blocked_by: q.includes("blocked_by = NULL") ? null : undefined,
          created_by_principal_id: "test",
          created_at: "2026-05-01",
          updated_at: "2026-05-01",
        },
      ];
    }
    if (q.includes("FROM work_items")) {
      return [
        {
          id: "bug.5005",
          type: "bug",
          title: "t",
          status: "needs_implement",
          node: "operator",
          actor: "either",
          assignees: [],
          external_refs: [],
          labels: [],
          spec_refs: [],
          revision: 0,
          deploy_verified: false,
          created_by_principal_id: "test",
          created_at: "2026-05-01",
          updated_at: "2026-05-01",
        },
      ];
    }
    return [];
  };
  return { sql: makeFakeDoltgresSql(respond, queries), queries };
}

describe("DoltgresWorkItemAdapter.patch — bug.5005 allowlist", () => {
  it("emits deploy_verified = TRUE for {deployVerified:true}", async () => {
    const { sql, queries } = makeFakeSql();
    const adapter = new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    });
    await adapter.patch(
      { reason: "test change", id: toWorkItemId("bug.5005"), set: { deployVerified: true } },
      "test"
    );
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toBeDefined();
    expect(update).toContain("deploy_verified = TRUE");
  });

  it("emits project_id = NULL for {projectId:null}", async () => {
    const { sql, queries } = makeFakeSql();
    const adapter = new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    });
    await adapter.patch(
      { reason: "test change", id: toWorkItemId("bug.5005"), set: { projectId: null } },
      "test"
    );
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toBeDefined();
    expect(update).toContain("project_id = NULL");
  });

  it("emits parent_id and blocked_by columns", async () => {
    const { sql, queries } = makeFakeSql();
    const adapter = new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    });
    await adapter.patch(
      {
        reason: "test change",
        id: toWorkItemId("bug.5005"),
        set: { parentId: toWorkItemId("task.5004"), blockedBy: null },
      },
      "test"
    );
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toBeDefined();
    expect(update).toContain("parent_id = 'task.5004'");
    expect(update).toContain("blocked_by = NULL");
  });

  it("still emits the existing whitelisted columns (title)", async () => {
    const { sql, queries } = makeFakeSql();
    const adapter = new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    });
    await adapter.patch(
      { reason: "test change", id: toWorkItemId("bug.5005"), set: { title: "renamed" } },
      "test"
    );
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toBeDefined();
    expect(update).toContain("title = 'renamed'");
  });
});

// REGRESSION, operator production 2026-10-08, and bug.0019: creator-binding
// locked out rows (first every row that predated the lease-column migration,
// then every row filed under a retired principal). The creator column is
// attribution only; no UPDATE predicate may mention it.
describe("patch is never scoped by creator", () => {
  it("emits no created_by_principal_id predicate for any patched field", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../src/adapters/doltgres/adapter.ts", import.meta.url),
        "utf8"
      )
    );
    expect(source).not.toContain(
      "created_by_principal_id IS NULL OR created_by_principal_id ="
    );
    expect(source).not.toMatch(/created_by_principal_id = \$\{escapeValue/);
    expect(source).not.toContain("mayMutate");
    expect(source).not.toContain("creatorPermits");
  });
});

// task.5284 (story.5096): `patch` honors `expectedRevision` as a real
// compare-and-set, and any principal the door admitted may patch (bug.0019).
const CAS_ID = "task.0001";
const CREATOR = "principal-creator";
const COLLABORATOR = "system-prioritizer";

const casSeed = {
  id: CAS_ID,
  type: "task",
  title: "triage me",
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
 * jsonb does not keep object key order: it stores shorter keys first, then
 * bytewise. Model that so the fake hands back `scores` the way a real jsonb
 * column does, not in the order the adapter wrote it.
 */
function asJsonb(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, asJsonb(inner)])
  );
}

/**
 * One in-memory row behind the stateful Dolt fake. The UPDATE arm honours the
 * statement's own `revision = N` predicate, so the CAS is exercised as SQL, not
 * assumed. It deliberately has no creator arm: a creator predicate must fail loudly. `concurrentBumpBeforeUpdate` models
 * a writer outside this adapter's lock landing between preflight and UPDATE.
 */
function casHarness(
  options: {
    concurrentBumpBeforeUpdate?: boolean;
    adapter?: Partial<DoltgresWorkItemAdapterOptions>;
  } = {}
) {
  const queries: string[] = [];
  const store = new Map<string, Record<string, unknown>>([
    [CAS_ID, { ...casSeed }],
  ]);
  const respond = (query: string) => {
    if (query.startsWith("SELECT id FROM work_items")) return [];
    if (query.startsWith("UPDATE work_items")) {
      const id = /WHERE id = '([^']+)'/.exec(query)?.[1] ?? "";
      const current = store.get(id);
      if (current && options.concurrentBumpBeforeUpdate) {
        current.revision = Number(current.revision) + 1;
      }
      if (!current) return [];
      const expected = /AND revision = (\d+)/.exec(query)?.[1];
      if (
        expected !== undefined &&
        Number(current.revision) !== Number(expected)
      )
        return [];
      const next: Record<string, unknown> = {
        ...current,
        revision: Number(current.revision) + 1,
        claim_active: false,
      };
      const priority = /\bpriority = (-?\d+)/.exec(query)?.[1];
      if (priority !== undefined) next.priority = Number(priority);
      const rank = /\brank = (NULL|-?\d+)/.exec(query)?.[1];
      if (rank !== undefined) next.rank = rank === "NULL" ? null : Number(rank);
      const labels = /\blabels = '(.*?)'::jsonb/.exec(query)?.[1];
      if (labels !== undefined) next.labels = JSON.parse(labels);
      const title = /\btitle = '([^']*)'/.exec(query)?.[1];
      if (title !== undefined) next.title = title;
      const scores = /\bscores = '(.*?)'::jsonb/.exec(query)?.[1];
      if (scores !== undefined) {
        next.scores = asJsonb(JSON.parse(scores.replace(/''/g, "'")));
      }
      if (/\bscores = NULL\b/.test(query)) next.scores = null;
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
    readClient: independentReadPool(sql),
    recreateClient: () => sql,
    ...options.adapter,
  });
  return { adapter, queries, store };
}

const branchCreated = (queries: string[]) =>
  queries.some((query) => query.includes("dolt_checkout('-b'"));
const committed = (queries: string[]) =>
  queries.some((query) => query.startsWith("SELECT dolt_commit"));
const updateOf = (queries: string[]) =>
  queries.find((query) => query.startsWith("UPDATE work_items"));

describe("DoltgresWorkItemAdapter.patch — expectedRevision CAS (task.5284)", () => {
  it("lands a matching expectedRevision and bumps revision by exactly one", async () => {
    const { adapter, queries } = casHarness();

    const result = await adapter.patch(
      { reason: "test change", id: toWorkItemId(CAS_ID), expectedRevision: 3, set: { title: "cas" } },
      CREATOR
    );

    expect(result).toMatchObject({ id: CAS_ID, title: "cas", revision: 4 });
    // The CAS is in the statement itself, not only in the preflight.
    expect(updateOf(queries)).toContain(
      `WHERE id = '${CAS_ID}' AND revision = 3 RETURNING`
    );
    expect(queries).toContain(
      `SELECT dolt_commit('-m', 'work-items: patch ${CAS_ID} by actor:${CREATOR}\nReason: test change')`
    );
  });

  it("refuses a stale expectedRevision before any branch or DML, leaving the row unchanged", async () => {
    const { adapter, queries, store } = casHarness();

    const attempt = adapter.patch(
      { reason: "test change", id: toWorkItemId(CAS_ID), expectedRevision: 2, set: { priority: 0 } },
      CREATOR
    );

    await expect(attempt).rejects.toBeInstanceOf(WorkItemRevisionConflictError);
    await expect(attempt).rejects.toMatchObject({
      id: CAS_ID,
      expectedRevision: 2,
      currentRevision: 3,
    });
    expect(branchCreated(queries)).toBe(false);
    expect(updateOf(queries)).toBeUndefined();
    expect(store.get(CAS_ID)).toMatchObject({ priority: 2, revision: 3 });
  });

  it("reports a conflict, commits nothing, and drops the op branch when the UPDATE loses a race", async () => {
    const { adapter, queries, store } = casHarness({
      concurrentBumpBeforeUpdate: true,
    });

    await expect(
      adapter.patch(
        { reason: "test change", id: toWorkItemId(CAS_ID), expectedRevision: 3, set: { priority: 0 } },
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
    expect(store.get(CAS_ID)).toMatchObject({ priority: 2, rank: 7 });
  });

  it("leaves an omitted expectedRevision unconditioned, as before", async () => {
    const { adapter, queries } = casHarness();

    await expect(
      adapter.patch(
        { reason: "test change", id: toWorkItemId(CAS_ID), set: { title: "plain" } },
        CREATOR
      )
    ).resolves.toMatchObject({ title: "plain", revision: 4 });
    expect(updateOf(queries)).not.toContain("AND revision =");
    expect(updateOf(queries)).toContain(
      `WHERE id = '${CAS_ID}' RETURNING`
    );
    expect(updateOf(queries)).not.toContain("created_by_principal_id");
  });

  it("rejects a malformed expectedRevision without touching the store", async () => {
    const { adapter, queries } = casHarness();

    await expect(
      adapter.patch(
        {
          reason: "test change",
          id: toWorkItemId(CAS_ID),
          expectedRevision: "abc",
          set: { priority: 1 },
        },
        CREATOR
      )
    ).rejects.toThrow(/expectedRevision/);
    expect(queries).toHaveLength(0);
  });
});

describe("DoltgresWorkItemAdapter.patch — non-creator principals (task.5284, bug.0019)", () => {
  it("lets a non-creator set priority, rank and labels", async () => {
    const { adapter, queries } = casHarness();

    await expect(
      adapter.patch(
        {
          reason: "test change",
          id: toWorkItemId(CAS_ID),
          expectedRevision: 3,
          set: { priority: 0, rank: 1, labels: ["triaged"] },
        },
        COLLABORATOR
      )
    ).resolves.toMatchObject({
      priority: 0,
      rank: 1,
      labels: ["triaged"],
      revision: 4,
    });
    expect(updateOf(queries)).not.toContain("created_by_principal_id");
    expect(updateOf(queries)).toContain("AND revision = 3");
    expect(queries).toContain(
      `SELECT dolt_commit('-m', 'work-items: patch ${CAS_ID} by actor:${COLLABORATOR}\nReason: test change')`
    );
  });

  it("lets a non-creator patch a non-triage field too, leaving the creator untouched (bug.0019)", async () => {
    const { adapter, queries, store } = casHarness();

    await expect(
      adapter.patch(
        { reason: "test change", id: toWorkItemId(CAS_ID), set: { priority: 0, title: "now yours" } },
        COLLABORATOR
      )
    ).resolves.toMatchObject({ priority: 0, title: "now yours", revision: 4 });
    expect(updateOf(queries)).not.toContain("created_by_principal_id");
    expect(committed(queries)).toBe(true);
    expect(store.get(CAS_ID)).toMatchObject({
      title: "now yours",
      created_by_principal_id: CREATOR,
    });
  });

  it("lets a non-creator write scores, proven despite jsonb key reordering (story.5111)", async () => {
    const { adapter, queries, store } = casHarness();
    const scores = {
      unblocks: { v: 4, ev: "https://cognidao.org/work/items/story.5108" },
      goal: {
        v: 5,
        ev: "https://cognidao.org/knowledge/goal-fleet-pays-itself",
      },
      ease: { v: 3 },
    };

    const result = await adapter.patch(
      { reason: "test change", id: toWorkItemId(CAS_ID), expectedRevision: 3, set: { scores } },
      COLLABORATOR
    );

    expect(result.scores).toEqual(scores);
    expect(result.revision).toBe(4);
    expect(updateOf(queries)).toContain("scores = '");
    expect(updateOf(queries)).not.toContain("created_by_principal_id");
    expect(committed(queries)).toBe(true);
    // Stored in jsonb order, not write order — the proof must still pass.
    expect(Object.keys(store.get(CAS_ID)?.scores as object)).toEqual([
      "ease",
      "goal",
      "unblocks",
    ]);
  });

  it("still refuses a blank principal", async () => {
    const { adapter, queries } = casHarness();

    await expect(
      adapter.patch({ reason: "test change", id: toWorkItemId(CAS_ID), set: { priority: 0 } }, "  ")
    ).rejects.toBeInstanceOf(WorkItemAuthorizationError);
    expect(queries).toHaveLength(0);
  });
});

describe("DoltgresWorkItemAdapter — scores (story.5111)", () => {
  const scores = {
    goal: { v: 5, ev: "https://cognidao.org/knowledge/goal-fleet-pays-itself" },
    ease: { v: 3 },
  };

  it("creates an item with scores and round-trips them", async () => {
    const queries: string[] = [];
    const sql = makeFakeDoltgresSql((query) => {
      if (!query.startsWith("INSERT INTO work_items")) return [];
      const id = /VALUES \('([^']+)'/.exec(query)?.[1] ?? "";
      const written = /'(\{.*?\}\})'::jsonb/.exec(query)?.[1];
      return [
        {
          ...casSeed,
          id,
          revision: 0,
          scores: written ? asJsonb(JSON.parse(written)) : null,
        },
      ];
    }, queries);

    const created = await new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    }).create({ type: "task", title: "scored", scores }, CREATOR);

    const insert = queries.find((q) => q.startsWith("INSERT INTO work_items"));
    expect(insert).toMatch(
      /^INSERT INTO work_items \([^)]*\bscores\b[^)]*\) VALUES/
    );
    expect(insert).toContain(`'${JSON.stringify(scores)}'::jsonb`);
    expect(created.scores).toEqual(scores);
    expect(committed(queries)).toBe(true);
  });

  it("reads a NULL scores column as absent", async () => {
    const { adapter, store } = casHarness();
    store.set(CAS_ID, { ...casSeed, scores: null });

    const item = await adapter.get(toWorkItemId(CAS_ID));

    expect(item).not.toBeNull();
    expect(item && "scores" in item).toBe(false);
  });

  it("drops entries whose v is not an integer instead of coercing them", async () => {
    const { adapter, store } = casHarness();
    store.set(CAS_ID, {
      ...casSeed,
      scores: {
        goal: { v: 4 },
        time: { v: null },
        ease: { v: true },
        agent: { v: "3" },
        unblocks: { v: 2.5 },
      },
    });

    const item = await adapter.get(toWorkItemId(CAS_ID));

    expect(item?.scores).toEqual({ goal: { v: 4 } });
  });

  it("clears scores to SQL NULL with scores:null, and the proof passes", async () => {
    const { adapter, queries, store } = casHarness();
    store.set(CAS_ID, { ...casSeed, scores: asJsonb(scores) });

    const result = await adapter.patch(
      { reason: "test change", id: toWorkItemId(CAS_ID), expectedRevision: 3, set: { scores: null } },
      COLLABORATOR
    );

    expect(updateOf(queries)).toContain("scores = NULL");
    expect(committed(queries)).toBe(true);
    expect(result.revision).toBe(4);
    expect("scores" in result).toBe(false);
    expect(store.get(CAS_ID)?.scores).toBeNull();
  });

  it("runs parseWorkItemScores on create: invalid scores throw before any query", async () => {
    const queries: string[] = [];
    const sql = makeFakeDoltgresSql(() => [], queries);

    await expect(
      new DoltgresWorkItemAdapter(sql, {
        readClient: independentReadPool(sql),
      }).create(
        { type: "task", title: "unevidenced", scores: { goal: { v: 5 } } },
        CREATOR
      )
    ).rejects.toBeInstanceOf(WorkItemScoresInvalidError);
    expect(queries).toHaveLength(0);
  });

  it("runs parseWorkItemScores on patch: invalid scores throw before any query", async () => {
    const { adapter, queries, store } = casHarness();

    await expect(
      adapter.patch(
        {
          reason: "test change",
          id: toWorkItemId(CAS_ID),
          expectedRevision: 3,
          set: { scores: { goal: { v: 4, ev: "http://external.example/x" } } },
        },
        COLLABORATOR
      )
    ).rejects.toMatchObject({
      name: "WorkItemScoresInvalidError",
      issues: [expect.objectContaining({ code: "evidence_not_https" })],
    });
    expect(queries).toHaveLength(0);
    expect(store.get(CAS_ID)?.scores).toBeUndefined();
  });

  it("round-trips an external HTTPS justification without node hostname configuration", async () => {
    const queries: string[] = [];
    const sql = makeFakeDoltgresSql((query) => {
      if (!query.startsWith("INSERT INTO work_items")) return [];
      const id = /VALUES \('([^']+)'/.exec(query)?.[1] ?? "";
      const written = /'(\{.*?\}\})'::jsonb/.exec(query)?.[1];
      return [
        {
          ...casSeed,
          id,
          revision: 0,
          scores: written ? asJsonb(JSON.parse(written)) : null,
        },
      ];
    }, queries);
    const options = { readClient: independentReadPool(sql) };
    const input = {
      type: "task" as const,
      title: "own domain",
      scores: { goal: { v: 4, ev: "https://mynode.org/goals/1" } },
    };

    const created = await new DoltgresWorkItemAdapter(sql, options).create(
      input,
      CREATOR
    );
    expect(created.scores).toEqual(input.scores);
    expect(committed(queries)).toBe(true);
  });
});

// task.0086: every patch carries a reason; cites are pinned by the resolver.
const COMMIT_A = "a".repeat(32);
const COMMIT_B = "0123456789abcdefghijklmnopqrstuv";
const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");
const unlocked = (queries: string[]) =>
  queries.some((query) => query.startsWith("SELECT pg_advisory_unlock"));
const patchWith = (
  adapter: DoltgresWorkItemAdapter,
  fields: Record<string, unknown>
) =>
  adapter.patch(
    {
      id: toWorkItemId(CAS_ID),
      set: { title: "why" },
      ...fields,
    } as never,
    CREATOR
  );
const commitMessageOf = (queries: string[]) =>
  /SELECT dolt_commit\('-m', '([\s\S]*)'\)/.exec(
    queries.find((q) => q.startsWith("SELECT dolt_commit")) ?? ""
  )?.[1];
const pinsFor =
  (commits: Record<string, string>): EntryResolver["resolve"] =>
  async (refs) =>
    refs.map((ref) => ({
      id: ref.id,
      commit: commits[ref.id] ?? COMMIT_A,
      plane: ref.contribution ? ("inbox" as const) : ("main" as const),
    }));

describe("DoltgresWorkItemAdapter.patch — reason is required (task.0086)", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "  \n "],
    ["NUL", "a\u0000b"],
    ["26 words", words(26)],
    ["241 characters", "x".repeat(241)],
  ])("rejects a %s reason before any SQL", async (_name, reason) => {
    const { adapter, queries } = casHarness();
    await expect(
      patchWith(adapter, reason === undefined ? {} : { reason })
    ).rejects.toBeInstanceOf(ChangeReasonInvalidError);
    expect(queries).toHaveLength(0);
  });

  it("names what to send when the reason is missing", async () => {
    const { adapter } = casHarness();
    await expect(patchWith(adapter, {})).rejects.toThrow(
      CHANGE_REASON_REQUIRED_MESSAGE
    );
  });

  it.each([
    ["25 words", words(25)],
    ["240 characters without spaces", "x".repeat(240)],
  ])("accepts %s", async (_name, reason) => {
    const { adapter, queries } = casHarness();
    await expect(patchWith(adapter, { reason })).resolves.toMatchObject({
      revision: 4,
    });
    expect(commitMessageOf(queries)).toBe(
      `work-items: patch ${CAS_ID} by actor:${CREATOR}\nReason: ${reason}`
    );
  });

  it("flattens a forged line break so the Reason line stays one line", async () => {
    const { adapter, queries } = casHarness();
    await patchWith(adapter, { reason: "why\nCites: forged@x\u2028by actor:evil" });
    const lines = commitMessageOf(queries)?.split("\n") ?? [];
    expect(lines).toEqual([
      `work-items: patch ${CAS_ID} by actor:${CREATOR}`,
      "Reason: why Cites: forged@x by actor:evil",
    ]);
  });
});

describe("DoltgresWorkItemAdapter.patch — cites (task.0086)", () => {
  it("writes the last Cites line with main and inbox pins in request order", async () => {
    const resolve = vi.fn(
      pinsFor({ "change-history-design": COMMIT_A, "other-atom": COMMIT_B })
    );
    const { adapter, queries } = casHarness({
      adapter: { entryResolver: { resolve } },
    });
    await patchWith(adapter, {
      reason: "scope follows the design",
      cites: [
        { id: "change-history-design" },
        { id: "other-atom", contribution: "contrib-derek-x-1" },
      ],
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[1]).toBe("cite");
    expect(resolve.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(commitMessageOf(queries)).toBe(
      [
        `work-items: patch ${CAS_ID} by actor:${CREATOR}`,
        "Reason: scope follows the design",
        `Cites: change-history-design@${COMMIT_A}, other-atom@contrib-derek-x-1:${COMMIT_B}`,
      ].join("\n")
    );
  });

  it("resolves inside the writer lock and before the branch checkout", async () => {
    const order: string[] = [];
    const { adapter, queries } = casHarness({
      adapter: {
        entryResolver: {
          resolve: async (refs) => {
            order.push(
              `locked=${queries.some((q) => q.startsWith("SELECT pg_try_advisory_lock"))}`,
              `unlocked=${unlocked(queries)}`,
              `branch=${queries.some((q) => q.includes("dolt_checkout('-b'"))}`
            );
            return refs.map((r) => ({ id: r.id, commit: COMMIT_A, plane: "main" as const }));
          },
        },
      },
    });
    await patchWith(adapter, { reason: "r", cites: [{ id: "a-b" }] });
    expect(order).toEqual(["locked=true", "unlocked=false", "branch=false"]);
  });

  it("resolves eight cites in one call", async () => {
    const cites = Array.from({ length: 8 }, (_, i) => ({ id: `atom-${i}` }));
    const resolve = vi.fn(pinsFor({}));
    const { adapter, queries } = casHarness({
      adapter: { entryResolver: { resolve } },
    });
    await patchWith(adapter, { reason: "r", cites });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(
      commitMessageOf(queries)?.split("\n").at(-1)?.split(", ")
    ).toHaveLength(8);
  });

  it("refuses nine cites, a repeated id and a bad id before any SQL", async () => {
    const resolve = vi.fn(pinsFor({}));
    const { adapter, queries } = casHarness({
      adapter: { entryResolver: { resolve } },
    });
    for (const cites of [
      Array.from({ length: 9 }, (_, i) => ({ id: `atom-${i}` })),
      [{ id: "same" }, { id: "same" }],
      [{ id: "bad\nid" }],
      [{ id: "ok", contribution: "not-contrib" }],
    ]) {
      await expect(patchWith(adapter, { reason: "r", cites })).rejects.toBeInstanceOf(
        CitesInvalidError
      );
    }
    expect(queries).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses cites with no resolver wired (a reason alone still works)", async () => {
    const { adapter, queries } = casHarness();
    await expect(
      patchWith(adapter, { reason: "r", cites: [{ id: "a-b" }] })
    ).rejects.toBeInstanceOf(CitesUnsupportedError);
    expect(queries).toHaveLength(0);
    await expect(patchWith(adapter, { reason: "r" })).resolves.toBeDefined();
  });

  it("an unknown id or a closed inbox is EntryUnresolvedError: lock released, nothing written", async () => {
    const { adapter, queries, store } = casHarness({
      adapter: {
        entryResolver: {
          resolve: async () => {
            throw new EntryUnresolvedError(["ghost"]);
          },
        },
      },
    });
    const attempt = patchWith(adapter, { reason: "r", cites: [{ id: "ghost" }] });
    await expect(attempt).rejects.toBeInstanceOf(EntryUnresolvedError);
    await expect(attempt).rejects.toMatchObject({ ids: ["ghost"] });
    expect(branchCreated(queries)).toBe(false);
    expect(committed(queries)).toBe(false);
    expect(updateOf(queries)).toBeUndefined();
    expect(unlocked(queries)).toBe(true);
    expect(store.get(CAS_ID)).toMatchObject({ title: "triage me", revision: 3 });
  });

  it("matches an unresolved error from a bundled copy of the class by name", async () => {
    class EntryUnresolvedError extends Error {
      readonly ids = ["ghost"];
      constructor() {
        super("copy");
        this.name = "EntryUnresolvedError";
      }
    }
    const { adapter } = casHarness({
      adapter: {
        entryResolver: {
          resolve: async () => {
            throw new EntryUnresolvedError();
          },
        },
      },
    });
    await expect(
      patchWith(adapter, { reason: "r", cites: [{ id: "ghost" }] })
    ).rejects.toMatchObject({ code: "cite_unresolved", ids: ["ghost"] });
  });

  it("wraps any other resolver error as EntryResolverUnavailableError and writes nothing", async () => {
    const { adapter, queries } = casHarness({
      adapter: {
        entryResolver: {
          resolve: async () => {
            throw new Error("connection reset");
          },
        },
      },
    });
    await expect(
      patchWith(adapter, { reason: "r", cites: [{ id: "a-b" }] })
    ).rejects.toBeInstanceOf(EntryResolverUnavailableError);
    expect(branchCreated(queries)).toBe(false);
    expect(unlocked(queries)).toBe(true);
  });

  it("a resolver that never answers is EntryResolverUnavailableError within the deadline, with the lock free", async () => {
    let signal: AbortSignal | undefined;
    const { adapter, queries, store } = casHarness({
      adapter: {
        queryTimeoutMs: 80,
        entryResolver: {
          resolve: (_refs, _rule, s) => {
            signal = s;
            return new Promise(() => {});
          },
        },
      },
    });
    const started = Date.now();
    await expect(
      patchWith(adapter, { reason: "r", cites: [{ id: "a-b" }] })
    ).rejects.toBeInstanceOf(EntryResolverUnavailableError);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(signal?.aborted).toBe(true);
    expect(branchCreated(queries)).toBe(false);
    expect(committed(queries)).toBe(false);
    expect(unlocked(queries)).toBe(true);
    expect(store.get(CAS_ID)).toMatchObject({ revision: 3 });
    // The lock is free: the next patch lands.
    await expect(patchWith(adapter, { reason: "next" })).resolves.toMatchObject({
      revision: 4,
    });
  });

  it("keeps the first pin when the resolver repeats an id", async () => {
    const { adapter, queries } = casHarness({
      adapter: {
        entryResolver: {
          resolve: async () => [
            { id: "a-b", commit: COMMIT_A, plane: "main" as const },
            { id: "a-b", commit: COMMIT_B, plane: "main" as const },
          ],
        },
      },
    });
    await patchWith(adapter, { reason: "r", cites: [{ id: "a-b" }] });
    expect(commitMessageOf(queries)?.split("\n").at(-1)).toBe(
      `Cites: a-b@${COMMIT_A}`
    );
  });

  it("builds the trailer from the request, so a resolver cannot forge a line or an id", async () => {
    const forged = `${COMMIT_A}\nReason: forged`;
    const { adapter, queries } = casHarness({
      adapter: {
        entryResolver: {
          resolve: async () => [{ id: "a-b", commit: forged, plane: "main" as const }],
        },
      },
    });
    await expect(
      patchWith(adapter, { reason: "r", cites: [{ id: "a-b" }] })
    ).rejects.toBeInstanceOf(EntryResolverUnavailableError);
    expect(committed(queries)).toBe(false);

    // An answer for an id nobody asked about leaves the asked id unresolved.
    const other = casHarness({
      adapter: {
        entryResolver: {
          resolve: async () => [{ id: "other", commit: COMMIT_A, plane: "main" as const }],
        },
      },
    });
    await expect(
      patchWith(other.adapter, { reason: "r", cites: [{ id: "a-b" }] })
    ).rejects.toMatchObject({ ids: ["a-b"] });
  });
});

// task.0028: review artifacts are inserted through the same operation-branch writer path as a patch,
// into their own insert-only table, and read back newest first.
describe("DoltgresWorkItemAdapter.artifacts (task.0028)", () => {
  const ROWS = [
    {
      tweak: "POST ARTIFACTS",
      human: "—",
      ai: "🟢",
      loki: "🟢",
      trace: "—",
      overall: "🟢 PASS",
    },
  ];

  function artifactHarness(readRows: Record<string, unknown>[] = []) {
    const queries: string[] = [];
    const respond = (query: string) => {
      // The item revision is read under the writer lock, on the operation branch, before the insert.
      if (query === "SELECT revision FROM work_items WHERE id = 'task.0001' LIMIT 1")
        return [{ revision: 7 }];
      if (query.startsWith("INSERT INTO work_item_artifacts")) {
        const values =
          /VALUES \('([^']+)', '([^']+)', (\d+), '([^']+)', '([^']*)', '([^']+)', (NULL|'.*?'::jsonb), (NULL|'(?:''|[^'])*'), (NULL|'(?:''|[^'])*'), (NULL|'(?:''|[^'])*'), '([^']+)'\) RETURNING/.exec(
            query
          );
        const [, id, itemId, revision, kind, subject, verdict, rows, note, body, url, author] =
          values ?? [];
        const text = (value: string | undefined) =>
          value === "NULL" ? null : String(value).slice(1, -1).replace(/''/g, "'");
        return [
          {
            id,
            item_id: itemId,
            item_revision: Number(revision),
            kind,
            subject,
            verdict,
            rows: rows === "NULL" ? null : JSON.parse(String(rows).slice(1, -8)),
            note: text(note),
            body: text(body),
            url: text(url),
            author,
            created_at: "2026-10-03T00:00:00.000Z",
          },
        ];
      }
      if (query.includes("FROM work_item_artifacts")) return readRows;
      return [];
    };
    const sql = makeFakeDoltgresSql(respond, queries);
    const adapter = new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
      recreateClient: () => sql,
    });
    return { adapter, queries };
  }

  const PR = "https://github.com/cogni-dao/node-template/pull/352";
  const input = {
    itemId: "task.0001",
    kind: "validation" as const,
    subject: `${PR}@${"a".repeat(40)}`,
    verdict: "pass",
    rows: ROWS as never,
    url: `${PR}#issuecomment-1`,
    note: "Main change: it's fine",
    body: "Full text, with a 'quote'",
    author: "validator-1",
  };

  it("inserts one row on an operation branch, adds only its table, and commits with the actor, a reason and the row id", async () => {
    const { adapter, queries } = artifactHarness();
    const stored = await adapter.artifacts.insert(input);

    expect(stored).toMatchObject({
      itemId: "task.0001",
      kind: "validation",
      verdict: "pass",
      url: input.url,
      note: "Main change: it's fine",
      body: "Full text, with a 'quote'",
      // Stamped from the item's revision read inside the lock, never from the caller.
      itemRevision: 7,
      author: "validator-1",
      rows: ROWS,
    });
    expect(stored.id).toMatch(/^wia-[0-9a-f-]{36}$/);
    const insert = queries.find((q) => q.startsWith("INSERT INTO work_item_artifacts"));
    expect(insert).toContain(
      '(id, item_id, item_revision, kind, subject, verdict, "rows", note, body, url, author)'
    );
    // The revision is read before the insert, in the same operation.
    const queryOrder = queries.map((q) => q.slice(0, 40));
    expect(queryOrder.findIndex((q) => q.startsWith("SELECT revision FROM work_items"))).toBeLessThan(
      queryOrder.findIndex((q) => q.startsWith("INSERT INTO work_item_artifacts"))
    );
    expect(branchCreated(queries)).toBe(true);
    expect(queries).toContain("SELECT dolt_add('work_item_artifacts')");
    expect(queries).not.toContain("SELECT dolt_add('work_items')");
    expect(queries).toContain(
      `SELECT dolt_commit('-m', 'work-items: artifact task.0001 by actor:validator-1\nReason: Record validation artifact with verdict pass\nArtifact: ${stored.id}')`
    );
    // The operation branch was proven (exact one-row added diff) and merged.
    expect(queries.some((q) => q.includes("FROM dolt_merge("))).toBe(true);
    expect(queries.some((q) => q.startsWith("SELECT id FROM work_item_artifacts WHERE id"))).toBe(true);
  });

  it("refuses an unknown kind or an empty author before any SQL is sent", async () => {
    const { adapter, queries } = artifactHarness();
    await expect(
      adapter.artifacts.insert({ ...input, kind: "approval" as never })
    ).rejects.toThrow(/Unknown artifact kind/);
    await expect(adapter.artifacts.insert({ ...input, author: "" })).rejects.toThrow();
    expect(branchCreated(queries)).toBe(false);
    expect(committed(queries)).toBe(false);
  });

  it("lists newest first in one bounded read, and the latest of each kind in one query", async () => {
    const stored = (kind: string, id: string) => ({
      id,
      item_id: "task.0001",
      kind,
      item_revision: 2,
      subject: "s",
      verdict: "approve",
      rows: null,
      note: null,
      body: "full review",
      url: "https://example.org/x",
      author: "a",
      created_at: new Date("2026-10-03T00:00:00.000Z"),
    });
    const { adapter, queries } = artifactHarness([stored("design_review", "wia-1")]);

    const listed = await adapter.artifacts.list("task.0001");
    expect(listed).toEqual([
      {
        id: "wia-1",
        itemId: "task.0001",
        itemRevision: 2,
        kind: "design_review",
        subject: "s",
        verdict: "approve",
        body: "full review",
        url: "https://example.org/x",
        author: "a",
        createdAt: "2026-10-03T00:00:00.000Z",
      },
    ]);
    expect(queries.at(-1)).toBe(
      "SELECT * FROM work_item_artifacts WHERE item_id = 'task.0001' ORDER BY created_at DESC, id DESC LIMIT 50"
    );

    const before = queries.length;
    await adapter.artifacts.latest("task.0001");
    const latestQueries = queries.slice(before);
    expect(latestQueries).toHaveLength(1);
    const latest = latestQueries[0] as string;
    expect(latest.startsWith("WITH latest AS (")).toBe(true);
    // The item read never pays for the review body: every branch lists the columns but `body`.
    expect(latest).not.toMatch(/\bbody\b/);
    expect(latest).not.toContain("(SELECT *");
    for (const kind of ["triage", "design_review", "implementation_review", "validation"]) {
      expect(latest).toContain(`kind = '${kind}' ORDER BY created_at DESC, id DESC LIMIT 1)`);
    }
    expect(latest.match(/UNION ALL/g)).toHaveLength(3);
    // The list does carry it.
    expect(queries.some((q) => q.startsWith("SELECT * FROM work_item_artifacts"))).toBe(true);
  });

  it("is insert-only: the adapter holds no UPDATE or DELETE of the artifact table", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../src/adapters/doltgres/adapter.ts", import.meta.url),
        "utf8"
      )
    );
    expect(source).not.toMatch(/UPDATE\s+(\$\{ARTIFACT_TABLE\}|work_item_artifacts)/);
    expect(source).not.toMatch(/DELETE\s+FROM\s+(\$\{ARTIFACT_TABLE\}|work_item_artifacts)/);
  });
});
