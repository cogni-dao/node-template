// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
/**
 * Module: `knowledge-store/tests/analytics`
 * Purpose: Prove evidence boundaries, partial retention and narrow SQL reader contracts.
 * Scope: Targeted tests with injected sources; no external services.
 * Invariants: UNKNOWN_IS_NOT_ZERO; AUTH_BEFORE_READS.
 * Side-effects: none outside the test process.
 * Links: https://cognidao.org/work/items/task.5329
 * @internal
 */
import { createDoltgresAnalyticsSources } from "../src/analytics/doltgres.js";
import {
  buildKnowledgeAnalytics,
  collectKnowledgeAnalytics,
  normalizeLookupEvents,
  semanticChangeIds,
} from "../src/analytics.js";

const window = {
  start: "2026-10-22T00:00:00.000Z",
  endExclusive: "2026-10-23T00:00:00.000Z",
};

describe("knowledge analytics evidence boundaries", () => {
  it("preserves reused caller IDs and deduplicates replayed events", () => {
    const result = normalizeLookupEvents("node-a", window, [
      { requestId: "caller", atomId: "rare", eventAt: "2026-10-22T10:00:00Z" },
      { requestId: "caller", atomId: "rare", eventAt: "2026-10-22T10:00:00Z" },
      { requestId: "caller", atomId: "rare", eventAt: "2026-10-22T11:00:00Z" },
      { requestId: "old", atomId: "rare", eventAt: "2026-10-21T10:00:00Z" },
      { requestId: "bad", atomId: "rare", eventAt: "bad" },
    ]);
    expect(result.events).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(result.invalidTimestamps).toBe(1);
    expect(result.outsideWindow).toBe(1);
  });

  it("does not turn confidence-only modifications into content changes", () => {
    expect(
      semanticChangeIds([
        {
          rowId: "a",
          changeType: "modified",
          before: { content: "same", confidencePct: 30 },
          after: { content: "same", confidencePct: 60 },
        },
        {
          rowId: "b",
          changeType: "modified",
          before: { useWhen: "old" },
          after: { useWhen: "new" },
        },
        {
          rowId: "c",
          changeType: "removed",
          before: { content: "gone" },
          after: null,
        },
        {
          rowId: "edge",
          changeType: "citation_added",
          before: null,
          after: { citedId: "a" },
        },
      ])
    ).toEqual(["b", "c"]);
  });

  it("keeps unavailable lookups null and unmatched changed atoms visible", () => {
    const report = buildKnowledgeAnalytics({
      nodeId: "node-a",
      window,
      generatedAt: window.endExclusive,
      inventory: {
        status: "complete",
        reason: null,
        value: [
          {
            id: "a",
            title: "A",
            domain: "meta",
            entryType: "goal",
            confidencePct: 100,
            sourceRef: "contribution:example:2",
          },
        ],
      },
      changes: {
        status: "partial",
        reason: "contribution_limit",
        value: [{ atomId: "removed", contributionId: "inbox-one" }],
      },
      backlog: { status: "complete", reason: null, value: 0 },
      lookups: {
        status: "unavailable",
        reason: "source_not_bound",
        value: null,
      },
    });
    expect(report.summary.lookupEvents).toBeNull();
    expect(report.rows.find((r) => r.id === "a")?.policyConfidence).toBeNull();
    expect(report.rows.find((r) => r.id === "removed")).toMatchObject({
      current: false,
      mergedChanges: 1,
      lookupEvents: null,
    });
    expect(report.coverage.changes.status).toBe("partial");
    expect(report.missionImpact).toBeNull();
    expect(report.rows.find((row) => row.id === "a")?.sourceRef).toBe(
      "contribution:example:2"
    );
  });
});

describe("bounded collection", () => {
  it("marks capped inventory and merged diff scans partial", async () => {
    let diffs = 0;
    const report = await collectKnowledgeAnalytics({
      nodeId: "node-a",
      hours: 24,
      now: () => Date.parse(window.endExclusive),
      signal: new AbortController().signal,
      sources: {
        domains: async () => ["meta"],
        atoms: async () =>
          Array.from({ length: 501 }, (_, i) => ({
            id: `atom-${i}`,
            title: `Atom ${i}`,
            domain: "meta",
          })),
        contributions: async (state) =>
          state === "open"
            ? []
            : Array.from({ length: 21 }, (_, i) => ({
                contributionId: `c-${i}`,
                resolvedAt: "2026-10-22T12:00:00Z",
              })),
        changeIds: async () => {
          diffs++;
          return ["atom-0"];
        },
      },
    });
    expect(diffs).toBe(20);
    expect(report.summary.mergedChanges).toBe(20);
    expect(report.coverage.changes.status).toBe("partial");
    expect(report.coverage.inventory.status).toBe("partial");
  });
  it("starts no source calls after cancellation or the cooperative deadline", async () => {
    for (const cancelled of [true, false]) {
      let calls = 0;
      let clock = Date.parse(window.endExclusive);
      const abort = new AbortController();
      if (cancelled) abort.abort();
      const report = await collectKnowledgeAnalytics({
        nodeId: "node-a",
        hours: 24,
        now: () => clock,
        signal: abort.signal,
        sources: {
          domains: async () => {
            calls++;
            clock += 12_001;
            return ["meta"];
          },
          atoms: async () => {
            calls++;
            return [];
          },
          contributions: async () => {
            calls++;
            return [];
          },
          changeIds: async () => {
            calls++;
            return [];
          },
        },
      });
      expect(calls).toBe(cancelled ? 0 : 1);
      expect(report.coverage.inventory).toMatchObject({
        status: "unavailable",
        reason: cancelled ? "cancelled" : "deadline",
      });
      expect(report.summary.currentAtoms).toBeNull();
    }
  });
});

it("retains known inventory as partial when a later domain fails", async () => {
  const report = await collectKnowledgeAnalytics({
    nodeId: "node-a",
    hours: 24,
    now: () => Date.parse(window.endExclusive),
    signal: new AbortController().signal,
    sources: {
      domains: async () => ["known", "failed"],
      atoms: async (domain) => {
        if (domain === "failed") throw new Error("source failure");
        return [{ id: "a", title: "A", domain }];
      },
      contributions: async () => [],
      changeIds: async () => [],
    },
  });
  expect(report.coverage.inventory).toMatchObject({
    status: "partial",
    reason: "source_error",
  });
  expect(report.summary.currentAtoms).toBe(1);
});

it("does not expose cached values from an unavailable source", () => {
  const report = buildKnowledgeAnalytics({
    nodeId: "node-a",
    window,
    generatedAt: window.endExclusive,
    inventory: {
      status: "unavailable",
      reason: "denied",
      value: [{ id: "secret", title: "Private", domain: "meta" }],
    },
    changes: {
      status: "unavailable",
      reason: "denied",
      value: [{ atomId: "secret", contributionId: "private" }],
    },
    backlog: { status: "unavailable", reason: "denied", value: 7 },
    lookups: {
      status: "unavailable",
      reason: "denied",
      value: [
        { atomId: "secret", requestId: "x", eventAt: "2026-10-22T10:00:00Z" },
      ],
    },
  });
  expect(report.rows).toEqual([]);
  expect(report.summary.openInboxes).toBeNull();
});

it("caps a large contribution diff and exposes normalization audit counts", async () => {
  const report = await collectKnowledgeAnalytics({
    nodeId: "node-a",
    hours: 24,
    now: () => Date.parse(window.endExclusive),
    signal: new AbortController().signal,
    sources: {
      domains: async () => [],
      atoms: async () => [],
      contributions: async (state) =>
        state === "open"
          ? []
          : [{ contributionId: "c", resolvedAt: "2026-10-22T12:00:00Z" }],
      changeIds: async () => Array.from({ length: 1001 }, (_, i) => `a-${i}`),
      lookups: async () => ({
        status: "complete",
        reason: null,
        value: [
          { requestId: "x", atomId: "gone", eventAt: "2026-10-22T12:00:00Z" },
          { requestId: "x", atomId: "gone", eventAt: "2026-10-22T12:00:00Z" },
        ],
      }),
    },
  });
  expect(report.summary.mergedChanges).toBe(1000);
  expect(report.coverage.changes.reason).toBe("change_row_limit");
  expect(report.lookupNormalization).toEqual({
    rawEvents: 2,
    duplicates: 1,
    invalidTimestamps: 0,
    outsideWindow: 0,
    cappedEvents: 0,
  });
});

it("preserves completed lookup evidence returned after cancellation", async () => {
  const abort = new AbortController();
  const report = await collectKnowledgeAnalytics({
    nodeId: "node-a",
    hours: 24,
    now: () => Date.parse(window.endExclusive),
    signal: abort.signal,
    sources: {
      domains: async () => [],
      atoms: async () => [],
      contributions: async () => [],
      changeIds: async () => [],
      lookups: async () => {
        abort.abort();
        return {
          status: "partial",
          reason: "cancelled",
          value: [
            { requestId: "x", atomId: "rare", eventAt: "2026-10-22T12:00:00Z" },
          ],
        };
      },
    },
  });
  expect(report.summary.lookupEvents).toBe(1);
  expect(report.coverage.lookups).toMatchObject({
    status: "partial",
    reason: "cancelled",
  });
});

it("does not claim absence from a partial inventory", () => {
  const report = buildKnowledgeAnalytics({
    nodeId: "node-a",
    window,
    generatedAt: window.endExclusive,
    inventory: { status: "partial", reason: "inventory_limit", value: [] },
    backlog: { status: "complete", reason: null, value: 0 },
    changes: {
      status: "complete",
      reason: null,
      value: [{ atomId: "unknown", contributionId: "c" }],
    },
    lookups: { status: "unavailable", reason: "source_not_bound", value: null },
  });
  expect(report.rows[0]?.current).toBeNull();
});

it("projects bounded metadata and changed IDs without hydrating bodies or accepting branch refs", async () => {
  const queries: string[] = [];
  const sources = createDoltgresAnalyticsSources({
    knowledgeSql: {
      unsafe: async (sql) => {
        queries.push(sql);
        return [];
      },
    },
  });
  await sources.domains();
  await sources.atoms("owner's-domain", 5);
  await sources.contributions("merged", 10);
  await sources.changeIds(
    {
      contributionId: "c",
      resolvedAt: null,
      baseCommit: "{00000000000000000000000000000000}",
      headCommit: "11111111111111111111111111111111",
    },
    20
  );
  expect(queries[0]).toContain("LIMIT 33");
  expect(queries[1]).toContain("domain = 'owner''s-domain'");
  expect(queries[1]).toContain("LIMIT 6");
  expect(queries[2]).toContain(
    "SELECT id, resolved_at, base_commit, head_commit"
  );
  expect(queries[2]).toContain("LIMIT 11");
  expect(queries[3]).toMatch(/^SELECT from_id, to_id FROM dolt_diff/);
  expect(queries[3]).toContain("diff_type = 'added' OR diff_type = 'removed'");
  expect(queries[3]).not.toContain(" IN (");
  expect(queries[3]).toContain(
    "CASE WHEN from_content = to_content THEN FALSE"
  );
  expect(queries[3]).not.toContain("<>");
  expect(queries[3]).toContain(
    "WHEN from_use_when IS NULL AND to_use_when IS NULL THEN FALSE ELSE TRUE END"
  );
  expect(queries[3]).not.toContain("confidence_pct");
  expect(queries[3]).toContain("LIMIT 21");
  expect(queries.every((q) => !q.includes("SELECT *"))).toBe(true);
  await expect(
    sources.changeIds(
      { contributionId: "c", resolvedAt: null, baseCommit: "main" },
      1
    )
  ).rejects.toThrow("invalid_contribution_receipt");
  await expect(sources.atoms("meta", 999999)).rejects.toThrow(
    "invalid_analytics_limit"
  );
  expect(queries).toHaveLength(4);
});

it("preserves adapter provenance through failures, partial normalization and a host deadline override", async () => {
  const sources = createDoltgresAnalyticsSources({
    knowledgeSql: {
      unsafe: async () => {
        throw new Error("private database diagnostic");
      },
    },
  });
  const scanWindow = {
    start: "2026-10-21T23:00:00.000Z",
    endExclusive: "2026-10-23T01:00:00.000Z",
  };
  const report = await collectKnowledgeAnalytics({
    nodeId: "node-a",
    hours: 24,
    now: () => Date.parse(window.endExclusive),
    signal: new AbortController().signal,
    deadlineMs: 40_000,
    sources: {
      ...sources,
      lookups: async () => ({
        status: "partial",
        reason: "request_budget",
        value: [{ requestId: "a", atomId: "rare", eventAt: "bad" }],
        provenance: {
          adapterVersion: "loki-lookup.v1",
          scanWindow,
          caps: { calls: 40, rowsPerCall: 1000, chunkHours: 24 },
        },
      }),
    },
  });
  expect(report.coverage.inventory).toMatchObject({
    status: "unavailable",
    reason: "source_error",
    provenance: {
      adapterVersion: "doltgres-projection.v1",
      scanWindow: null,
      caps: { atoms: 500, rowsPerCall: 501 },
    },
  });
  expect(report.coverage.lookups.provenance).toEqual({
    adapterVersion: "loki-lookup.v1",
    scanWindow,
    caps: { calls: 40, rowsPerCall: 1000, chunkHours: 24 },
  });
  expect(report.lookupNormalization.invalidTimestamps).toBe(1);
  expect(report.collectionLimits).toMatchObject({
    calls: 64,
    atoms: 500,
    changes: 1000,
    deadlineMs: 40_000,
  });
  expect(JSON.stringify(report)).not.toContain("private database diagnostic");
});
