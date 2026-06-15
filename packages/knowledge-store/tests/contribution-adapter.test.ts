// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/contribution-adapter`
 * Purpose: Focused unit coverage for Doltgres contribution adapter revision selection and metadata ordering.
 * Scope: Uses fake postgres.js clients; does not connect to Doltgres.
 * Invariants: CONTRIBUTION_DIFF_ANCHORED_TO_BASE, CONTRIBUTION_METADATA_BEFORE_BRANCH_DELETE.
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md, packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts
 * @internal
 */

import type { ReservedSql, Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresKnowledgeContributionAdapter } from "../src/adapters/doltgres/contribution-adapter.js";
import type { Principal } from "../src/domain/contribution-schemas.js";
import { CitationTargetNotFoundError } from "../src/port/knowledge-store.port.js";

const record = {
  id: "contrib-agent-1-abc123",
  branch: "contrib/agent-1-abc123",
  base_commit: "base123",
  head_commit: "head123",
  commit_count: 3,
  state: "open",
  principal_kind: "agent",
  principal_id: "agent-1",
  message: "branch edit",
  merged_commit: null,
  closed_reason: null,
  idempotency_key: null,
  created_at: new Date("2026-05-19T00:00:00.000Z"),
  resolved_at: null,
  resolved_by: null,
} satisfies Record<string, unknown>;

const reviewer: Principal = {
  id: "user-1",
  kind: "user",
  role: "admin",
};

class FakeReservedSql {
  readonly queries: string[] = [];

  async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    this.queries.push(query);
    if (query.includes("dolt_hashof")) {
      return [{ dolt_hashof: "head123" }];
    }
    if (query.includes("dolt_commit")) {
      return [{ dolt_commit: ["{next456}"] }];
    }
    if (query.includes("FROM domains")) {
      return [{ "?column?": 1 }];
    }
    if (query.includes("dolt_merge")) {
      return [{ dolt_merge: ["merge123"] }];
    }
    if (query.includes("UPDATE knowledge_contributions")) {
      const rows: Record<string, unknown>[] & { count?: number } = [];
      rows.count = 1;
      return rows;
    }
    if (query.includes("FROM knowledge_contribution_commits")) {
      return [
        {
          contribution_id: "contrib-agent-1-abc123",
          seq: 4,
          commit_hash: "next456",
          principal_kind: "agent",
          principal_id: "agent-1",
          auth_source: "bearer",
          message: "append",
          edit_count: 1,
          source_ref: "contribution:contrib-agent-1-abc123:4",
          created_at: new Date("2026-05-19T00:00:00.000Z"),
        },
      ];
    }
    return [];
  }

  release(): void {
    this.queries.push("release");
  }
}

class FakeSql {
  readonly queries: string[] = [];
  readonly conn = new FakeReservedSql();

  constructor(
    private readonly contributionRecord: Record<string, unknown> = record
  ) {}

  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (query.includes("FROM knowledge_contributions")) {
      return [this.contributionRecord];
    }
    if (query.includes("dolt_diff")) {
      return [];
    }
    return [];
  }

  async reserve(): Promise<ReservedSql> {
    return this.conn as unknown as ReservedSql;
  }
}

function adapterFor(fake: FakeSql): DoltgresKnowledgeContributionAdapter {
  return new DoltgresKnowledgeContributionAdapter({
    sql: fake as unknown as Sql,
  });
}

describe("DoltgresKnowledgeContributionAdapter", () => {
  it("anchors contribution diff to the recorded base and head commits", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(fake.queries.at(-1)).toContain(
      "dolt_diff('base123', 'head123', 'knowledge')"
    );
  });

  it("uses base commit as both sides for diff when no branch commit exists", async () => {
    const fake = new FakeSql({ ...record, head_commit: null, commit_count: 0 });

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(fake.queries.at(-1)).toContain(
      "dolt_diff('base123', 'base123', 'knowledge')"
    );
  });

  it("normalizes persisted brace-wrapped refs before building diff refs", async () => {
    const fake = new FakeSql({
      ...record,
      base_commit: "{base123}",
      head_commit: "{head123}",
    });

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(fake.queries.at(-1)).toContain(
      "dolt_diff('base123', 'head123', 'knowledge')"
    );
  });

  it("commits merge metadata before deleting the contribution branch", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).merge({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
    });

    const updateIndex = fake.conn.queries.findIndex((query) =>
      query.includes("SET state = 'merged'")
    );
    const commitIndex = fake.conn.queries.findIndex((query) =>
      query.includes("contrib-merge: contrib-agent-1-abc123")
    );
    const deleteIndex = fake.conn.queries.findIndex((query) =>
      query.includes("dolt_branch('-D'")
    );

    expect(updateIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(updateIndex);
    expect(deleteIndex).toBeGreaterThan(commitIndex);
  });

  it("commits close metadata before deleting the contribution branch", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).close({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
      reason: "superseded",
    });

    const updateIndex = fake.conn.queries.findIndex((query) =>
      query.includes("SET state = 'closed'")
    );
    const commitIndex = fake.conn.queries.findIndex((query) =>
      query.includes("contrib-close: contrib-agent-1-abc123")
    );
    const deleteIndex = fake.conn.queries.findIndex((query) =>
      query.includes("dolt_branch('-D'")
    );

    expect(updateIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(updateIndex);
    expect(deleteIndex).toBeGreaterThan(commitIndex);
  });

  it("accepts Dolt commit refs returned with and without braces while appending", async () => {
    const fake = new FakeSql();

    const commit = await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "append",
      edits: [
        {
          op: "insert",
          entry: {
            id: "row-1",
            domain: "meta",
            title: "row",
            content: "content",
          },
        },
      ],
    });

    expect(commit.commitHash).toBe("next456");
    expect(fake.conn.queries).toContain(
      "SELECT dolt_hashof('contrib/agent-1-abc123') AS dolt_hashof"
    );
    expect(
      fake.conn.queries.some((query) =>
        query.includes("head_commit = 'head123'")
      )
    ).toBe(true);
  });

  // bug.5024: an EDO batch citing a row that was merged to main AFTER the
  // contribution branch forked. The target resolves on main but not on the
  // branch HEAD; the cite must still succeed (main ∪ branch resolution) and
  // the edge is recorded on the branch. createEdoDecision writes a
  // `derives_from` edge to a hypothesis — no branch-local confidence recompute,
  // so this exercises the cross-plane resolve + main-only INSERT path.
  it("accepts a cross-plane EDO cite (target on main, absent from branch)", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map([["hyp-merged-main", "hypothesis"]]),
      branchEntryTypes: new Map(),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
    });
    const rec = await adapter.createEdoDecision({
      principal: { id: "agent-1", kind: "agent" },
      message: "decide from a merged-main hypothesis on a fresh branch",
      entry: {
        id: "dec-1",
        domain: "meta",
        title: "decision",
        content: "content",
      },
      derivesFromHypothesisId: "hyp-merged-main",
    });

    expect(rec.contributionId).toBe("contrib-agent-1-abc123");
    // The edge is recorded on the branch even though the target is main-only.
    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("INSERT INTO citations") && q.includes("'hyp-merged-main'")
      )
    ).toBe(true);
    // main was consulted for the cited entry_type when the branch lookup missed.
    expect(
      fake.queries.some(
        (q) =>
          q.includes("entry_type FROM knowledge") &&
          q.includes("'hyp-merged-main'")
      )
    ).toBe(true);
  });

  // bug.5024 parity for the generic op:cite path (not the EDO batch ops). An
  // agent appends a `supports` edge whose cited target was merged to main AFTER
  // the branch forked: it resolves on main but is absent from the branch HEAD.
  // The citing row lives on the branch. The cite must succeed (main ∪ branch),
  // the edge INSERTs on the branch, and the branch-local confidence recompute
  // is skipped because the cited row only exists on main.
  it("accepts a cross-plane op:cite append (cited on main, citing on branch)", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map([["cited-merged-main", "finding"]]),
      branchEntryTypes: new Map([["citing-on-branch", "finding"]]),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
    });
    const commit = await adapter.appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "link to a merged-main finding",
      edits: [
        {
          op: "cite",
          citingId: "citing-on-branch",
          citedId: "cited-merged-main",
          citationType: "supports",
        },
      ],
    });

    expect(commit.commitHash).toBe("next456");
    // The edge is recorded on the branch even though the target is main-only.
    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("INSERT INTO citations") &&
          q.includes("'cited-merged-main'")
      )
    ).toBe(true);
    // main was consulted for the cited entry_type when the branch lookup missed.
    expect(
      fake.queries.some(
        (q) =>
          q.includes("entry_type FROM knowledge") &&
          q.includes("'cited-merged-main'")
      )
    ).toBe(true);
    // Cross-plane: no branch-local confidence recompute on the main-only target.
    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("UPDATE knowledge SET confidence_pct") &&
          q.includes("'cited-merged-main'")
      )
    ).toBe(false);
  });

  it("throws CitationTargetNotFoundError when the cited row is on neither branch nor main", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map(),
      branchEntryTypes: new Map(),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
    });
    await expect(
      adapter.createEdoDecision({
        principal: { id: "agent-1", kind: "agent" },
        message: "decide from a bogus hypothesis id",
        entry: {
          id: "dec-2",
          domain: "meta",
          title: "decision",
          content: "content",
        },
        derivesFromHypothesisId: "does-not-exist-anywhere",
      })
    ).rejects.toBeInstanceOf(CitationTargetNotFoundError);
  });
});

/**
 * Fakes that distinguish the branch (reserved connection) plane from the merged
 * `main` (pool) plane so the cross-plane cite path (bug.5024) can be exercised.
 * `entry_type FROM knowledge` reads resolve against the per-plane id maps; the
 * domain-registry + citing-row existence checks always resolve on the branch.
 */
function idFromQuery(query: string): string | undefined {
  return query.match(/id = '([^']+)'/)?.[1];
}

class CrossPlaneFakeReservedSql {
  readonly queries: string[] = [];

  constructor(private readonly branchEntryTypes: Map<string, string>) {}

  async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    this.queries.push(query);
    if (query.includes("dolt_hashof")) return [{ dolt_hashof: "head123" }];
    if (query.includes("dolt_commit")) return [{ dolt_commit: ["{next456}"] }];
    if (query.includes("FROM domains")) return [{ "?column?": 1 }];
    if (query.includes("entry_type FROM knowledge")) {
      const t = this.branchEntryTypes.get(idFromQuery(query) ?? "");
      return t ? [{ entry_type: t }] : [];
    }
    // assertKnowledgeRowExists (citing-row presence) resolves on the branch.
    if (query.includes("SELECT 1 FROM knowledge")) {
      return this.branchEntryTypes.has(idFromQuery(query) ?? "") ? [{}] : [];
    }
    if (query.includes("UPDATE knowledge_contributions")) {
      const rows: Record<string, unknown>[] & { count?: number } = [];
      rows.count = 1;
      return rows;
    }
    return [];
  }

  release(): void {
    this.queries.push("release");
  }
}

class CrossPlaneFakeSql {
  readonly queries: string[] = [];
  readonly conn: CrossPlaneFakeReservedSql;
  private readonly mainEntryTypes: Map<string, string>;

  constructor(opts: {
    mainEntryTypes: Map<string, string>;
    branchEntryTypes: Map<string, string>;
  }) {
    this.mainEntryTypes = opts.mainEntryTypes;
    this.conn = new CrossPlaneFakeReservedSql(opts.branchEntryTypes);
  }

  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (query.includes("FROM knowledge_contributions")) return [record];
    if (query.includes("entry_type FROM knowledge")) {
      const t = this.mainEntryTypes.get(idFromQuery(query) ?? "");
      return t ? [{ entry_type: t }] : [];
    }
    if (query.includes("dolt_diff")) return [];
    return [];
  }

  async reserve(): Promise<ReservedSql> {
    return this.conn as unknown as ReservedSql;
  }
}
