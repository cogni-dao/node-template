// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/graph-read`
 * Purpose: Pins the whole-graph read: revision ETag/304 without a read, one pinned projected read per revision shared by concurrent callers, budget logging, retryable 503 on deadline/abort/failure, and the doltgres snapshot's projection and HEAD pinning (task.0059).
 * Scope: `readKnowledgeGraph` over the fake adapter and a mocked port; `DoltgresKnowledgeStoreAdapter.readKnowledgeGraphSnapshot` over a mocked transport. No database.
 * Side-effects: none
 * Links: task.0059, ../src/domain/graph-read.ts
 */

import { describe, expect, it, vi } from "vitest";

import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";
import {
  KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET,
  KNOWLEDGE_GRAPH_ENVELOPE_BYTES_BUDGET,
  KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET,
  KNOWLEDGE_GRAPH_RESPONSE_BYTES_BUDGET,
} from "../src/contracts.js";
import {
  type KnowledgeGraphReadPort,
  knowledgeGraphBudgetBytes,
  readKnowledgeGraph,
} from "../src/domain/graph-read.js";
import type { KnowledgeGraphSnapshot } from "../src/domain/knowledge-graph.js";
import { KnowledgeBusyError } from "../src/port/knowledge-store.port.js";

function snapshot(revision: string, nodes = 3): KnowledgeGraphSnapshot {
  return {
    revision,
    domains: ["meta"],
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: `k-${i}`,
      domain: "meta",
      title: `Entry ${i}`,
      entryType: "guide",
      confidencePct: 50,
      sourceType: "agent",
    })),
    citations: [
      { id: "c-0", citingId: "k-0", citedId: "k-1", citationType: "supports" },
      // Work-item endpoint: dropped (entry→entry only).
      { id: "c-1", citingId: "k-0", citedId: "task.1", citationType: "tracks" },
    ],
  };
}

function port(revision: () => string, read = vi.fn(async () => snapshot(revision()))) {
  return {
    port: { currentCommit: async () => revision(), readKnowledgeGraphSnapshot: read },
    read,
  } satisfies { port: KnowledgeGraphReadPort; read: unknown };
}

describe("readKnowledgeGraph", () => {
  it("serves the whole graph with ETag and logs counts, bytes and budget", async () => {
    const { port: p } = port(() => "rev-a");
    const result = await readKnowledgeGraph(p);
    expect(result.status).toBe(200);
    expect(result.headers).toMatchObject({
      ETag: '"rev-a"',
      "Cache-Control": "private, no-cache, must-revalidate",
    });
    const body = JSON.parse(result.body ?? "");
    expect(body.revision).toBe("rev-a");
    expect(body.nodes).toHaveLength(3);
    expect(body.edges).toEqual([
      { id: "c-0", source: "k-0", target: "k-1", citationType: "supports" },
    ]);
    expect(result.log).toMatchObject({
      event: "knowledge.graph_read",
      status: 200,
      outcome: "success",
      notModified: false,
      memoHit: false,
      nodes: 3,
      edges: 1,
      domains: 1,
      bytes: Buffer.byteLength(result.body ?? ""),
      budgetBytes:
        KNOWLEDGE_GRAPH_ENVELOPE_BYTES_BUDGET +
        3 * KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET +
        KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET,
      budgetExceeded: false,
    });
    expect(JSON.stringify(result.log)).not.toContain("Entry");
  });

  it("answers an unchanged revision with 304 and no graph read; any of a list, weak or *", async () => {
    const { port: p, read } = port(() => "rev-a");
    for (const tag of ['"rev-a"', 'W/"rev-a"', '"old", "rev-a"', "*"]) {
      const result = await readKnowledgeGraph(p, { ifNoneMatch: tag });
      expect(result.status).toBe(304);
      expect(result.body).toBeNull();
      expect(result.headers.ETag).toBe('"rev-a"');
      expect(result.log).toMatchObject({ status: 304, notModified: true });
    }
    expect(read).not.toHaveBeenCalled();
    expect((await readKnowledgeGraph(p, { ifNoneMatch: '"old"' })).status).toBe(200);
  });

  it("reads once per revision, shares one in-flight read, and rereads on a new revision", async () => {
    let revision = "rev-a";
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async () => {
      await gate;
      return snapshot(revision);
    });
    const { port: p } = port(() => revision, read);
    const concurrent = [readKnowledgeGraph(p), readKnowledgeGraph(p)];
    release();
    const [a, b] = await Promise.all(concurrent);
    expect(read).toHaveBeenCalledTimes(1);
    expect(a.body).toBe(b.body);
    expect(b.log.memoHit).toBe(true);
    expect((await readKnowledgeGraph(p)).log.memoHit).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    revision = "rev-b";
    const changed = await readKnowledgeGraph(p);
    expect(read).toHaveBeenCalledTimes(2);
    expect(changed.headers.ETag).toBe('"rev-b"');
  });

  it("labels and memoizes the snapshot's own revision when a commit lands in between", async () => {
    const read = vi.fn(async () => snapshot("rev-b"));
    const { port: p } = port(() => "rev-a", read);
    const result = await readKnowledgeGraph(p);
    expect(result.headers.ETag).toBe('"rev-b"');
    expect(JSON.parse(result.body ?? "").revision).toBe("rev-b");
  });

  it("flags budgetExceeded past the per-element or whole-response budget, never truncating", async () => {
    expect(knowledgeGraphBudgetBytes(10, 10)).toBe(
      KNOWLEDGE_GRAPH_ENVELOPE_BYTES_BUDGET +
        10 * KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET +
        10 * KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET,
    );
    expect(knowledgeGraphBudgetBytes(1_000_000, 1_000_000)).toBe(
      KNOWLEDGE_GRAPH_RESPONSE_BYTES_BUDGET,
    );
    const heavy = snapshot("rev-heavy", 2);
    // Titles far past the per-node budget push the whole body past envelope + elements.
    for (const node of heavy.nodes) node.title = "x".repeat(KNOWLEDGE_GRAPH_ENVELOPE_BYTES_BUDGET);
    const { port: p } = port(() => "rev-heavy", vi.fn(async () => heavy));
    const result = await readKnowledgeGraph(p);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body ?? "").nodes).toHaveLength(2);
    expect(result.log.budgetExceeded).toBe(true);
  });

  it("turns deadline, failure, a missing port or an aborted caller into a retryable 503 and forgets the failure", async () => {
    let fail = true;
    const read = vi.fn(async () => {
      if (fail) throw new KnowledgeBusyError("deadline");
      return snapshot("rev-a");
    });
    const { port: p } = port(() => "rev-a", read);
    const failed = await readKnowledgeGraph(p);
    expect(failed.status).toBe(503);
    expect(failed.headers["Retry-After"]).toBe("1");
    expect(JSON.parse(failed.body ?? "")).toEqual({ error: "graph_unavailable", retryable: true });
    expect(failed.log).toMatchObject({ status: 503, errorCode: "graph_unavailable", errorName: "KnowledgeBusyError" });
    fail = false;
    expect((await readKnowledgeGraph(p)).status).toBe(200);
    expect((await readKnowledgeGraph(null)).status).toBe(503);

    let hold: () => void = () => undefined;
    const slow = vi.fn(
      () => new Promise<KnowledgeGraphSnapshot>((resolve) => {
        hold = () => resolve(snapshot("rev-slow"));
      }),
    );
    const { port: q } = port(() => "rev-slow", slow);
    const controller = new AbortController();
    const aborted = readKnowledgeGraph(q, { signal: controller.signal });
    const other = readKnowledgeGraph(q);
    controller.abort();
    expect((await aborted).status).toBe(503);
    hold();
    // The shared read survives one caller's abort.
    expect((await other).status).toBe(200);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("serves the fake adapter's corpus at its current commit", async () => {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "meta", name: "Meta" });
    await store.withWrite({ operationId: "graph", message: "fixture" }, async (write) => {
      for (const id of ["a", "b"])
        await write.addKnowledge({ id, domain: "meta", title: id, content: "body", sourceType: "human" });
      await write.addCitation({ citingId: "a", citedId: "b", citationType: "extends" });
    });
    const result = await readKnowledgeGraph(store);
    const body = JSON.parse(result.body ?? "");
    expect(body.revision).toBe(await store.currentCommit());
    expect(body.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["a", "b"]);
    expect(body.edges).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("body");
  });
});

describe("DoltgresKnowledgeStoreAdapter.readKnowledgeGraphSnapshot", () => {
  it("projects nodes and citations and pins them between two equal HEAD reads", async () => {
    const { DoltgresKnowledgeStoreAdapter } = await import("../src/adapters/doltgres/index.js");
    const heads = ["h-1", "h-2", "h-2", "h-2"];
    const queries: string[] = [];
    const sql = {
      options: { max: 2 },
      unsafe: vi.fn(async (query: string) => {
        queries.push(query);
        if (query.includes("dolt_hashof")) return [{ hash: heads.shift() }];
        if (query.startsWith("SELECT DISTINCT domain")) return [{ domain: "meta" }];
        if (query.includes("FROM knowledge"))
          return [{ id: "a", domain: "meta", title: "A", entry_type: null, confidence_pct: "40", source_type: "agent" }];
        return [{ id: "c", citing_id: "a", cited_id: "a", citation_type: "supports" }];
      }),
    };
    const store = new DoltgresKnowledgeStoreAdapter({ sql: sql as never });
    const result = await store.readKnowledgeGraphSnapshot();
    // First attempt saw HEAD move (h-1 → h-2) and retried; the second was pinned.
    expect(result.revision).toBe("h-2");
    expect(result.nodes).toEqual([
      { id: "a", domain: "meta", title: "A", entryType: "finding", confidencePct: 40, sourceType: "agent" },
    ]);
    expect(result.citations).toEqual([
      { id: "c", citingId: "a", citedId: "a", citationType: "supports" },
    ]);
    expect(queries).toContain(
      "SELECT id, domain, title, entry_type, confidence_pct, source_type FROM knowledge",
    );
    expect(queries).toContain("SELECT id, citing_id, cited_id, citation_type FROM citations");
    expect(queries.some((q) => /SELECT \*|\bcontent\b/.test(q))).toBe(false);
  });

  it("gives up with a retryable busy error when HEAD keeps moving, and honors the graph deadline", async () => {
    const { DoltgresKnowledgeStoreAdapter } = await import("../src/adapters/doltgres/index.js");
    let n = 0;
    const moving = new DoltgresKnowledgeStoreAdapter({
      sql: {
        options: { max: 2 },
        unsafe: async (query: string) =>
          query.includes("dolt_hashof") ? [{ hash: `h-${n++}` }] : [],
      } as never,
    });
    await expect(moving.readKnowledgeGraphSnapshot()).rejects.toMatchObject({
      code: "KNOWLEDGE_BUSY",
      retryable: true,
    });
    vi.useFakeTimers();
    try {
      const stalled = new DoltgresKnowledgeStoreAdapter({
        sql: {
          options: { max: 2 },
          unsafe: () => new Promise<never>(() => undefined),
        } as never,
        graphTimeoutMs: 30,
      });
      const failed = expect(stalled.readKnowledgeGraphSnapshot()).rejects.toMatchObject({
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(30);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });
});
