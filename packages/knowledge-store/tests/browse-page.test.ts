import { expect, it, vi } from "vitest";
import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";
import {
  KnowledgeBrowseCursorError,
  KnowledgeBrowseQueryError,
} from "../src/domain/browse-errors.js";

it("continues through empty search windows to a literal body match beyond 500", async () => {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: "test", name: "Test" });
  await store.withWrite(
    { operationId: "browse-fixture", message: "fixture" },
    async (write) => {
      for (let i = 0; i < 522; i++)
        await write.addKnowledge({
          id: `row-${String(i).padStart(4, "0")}`,
          domain: "test",
          title: "Ordinary",
          content: i === 521 ? "Only body has İ%_match" : "nothing",
          sourceType: "human",
        });
    }
  );
  let cursor: string | undefined;
  const found: string[] = [];
  let windows = 0;
  do {
    const result = await store.browseKnowledge({
      sort: "id",
      direction: "asc",
      search: "i̇%_MATCH",
      cursor,
    });
    expect(result.scannedRows).toBeLessThanOrEqual(20);
    expect(JSON.stringify(result.items)).not.toContain("Only body");
    found.push(...result.items.map((item) => item.id));
    cursor = result.nextCursor ?? undefined;
    windows++;
  } while (cursor && windows < 30);
  expect(found).toEqual(["row-0521"]);
  expect(windows).toBe(27);
});

it("binds continuation to the complete query and retains an empty exact filter", async () => {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: "early", name: "Early" });
  await store.registerDomain({ id: "late", name: "Late" });
  await store.withWrite(
    { operationId: "filters", message: "fixture" },
    async (write) => {
      for (let i = 0; i < 22; i++)
        await write.addKnowledge({
          id: `tie-${String(i).padStart(2, "0")}`,
          domain: i === 21 ? "late" : "early",
          title: "Tie",
          content: "body",
          sourceType: "human",
        });
    }
  );
  const first = await store.browseKnowledge({ sort: "id", direction: "asc" });
  expect(first.items.map((r) => r.id)).toEqual(
    Array.from({ length: 20 }, (_, i) => `tie-${String(i).padStart(2, "0")}`)
  );
  const next = await store.browseKnowledge({
    sort: "id",
    direction: "asc",
    cursor: required(first.nextCursor),
  });
  expect(next.items.map((r) => r.id)).toEqual(["tie-20", "tie-21"]);
  await expect(
    store.browseKnowledge({
      sort: "id",
      direction: "asc",
      domains: ["late"],
      cursor: required(first.nextCursor),
    })
  ).rejects.toThrow();
  expect(
    (await store.browseKnowledge({ domains: ["late"] })).items.map((r) => r.id)
  ).toEqual(["tie-21"]);
  expect((await store.browseKnowledge({ domains: ["missing"] })).items).toEqual(
    []
  );
});

it("projects metadata in one global native query without fetching bodies", async () => {
  const { DoltgresKnowledgeStoreAdapter } = await import(
    "../src/adapters/doltgres/index.js"
  );
  const queries: string[] = [];
  const sql = {
    unsafe: async (query: string) => {
      if (query.includes("dolt_hashof")) return [{ hash: "head-a" }];
      if (query.startsWith("SELECT COUNT(*)")) return [{ total: 0 }];
      queries.push(query);
      return [];
    },
  };
  const store = new DoltgresKnowledgeStoreAdapter({ sql: sql as never });
  expect((await store.browseKnowledge({})).items).toEqual([]);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatch(
    /^SELECT id, domain, entity_id, title, entry_type, confidence_pct, source_type, use_when, created_at, CAST\(date_trunc\('microseconds', created_at\) AS TEXT\) AS browse_created_at FROM knowledge /
  );
  expect(queries[0]).not.toMatch(/\bcontent\b|SELECT \*/);
  expect(queries[0]).toMatch(/LIMIT 21$/);
});

it("matches an independent fixed-corpus oracle for every exposed order, nulls and any-of filters", async () => {
  const store = new FakeKnowledgeStoreAdapter();
  for (const id of ["a", "late"]) await store.registerDomain({ id, name: id });
  const records: Array<Record<string, string | number | null>> = [];
  await store.withWrite(
    { operationId: "sort-fixture", message: "fixture" },
    async (write) => {
      for (let i = 0; i < 47; i++) {
        const row = await write.addKnowledge({
          id: `n-${String(i).padStart(2, "0")}`,
          domain: i % 3 ? "a" : "late",
          title: "Title",
          content: i % 7 ? "plain" : "literal %_ İ",
          entryType: i % 2 ? "guide" : "finding",
          sourceType: i % 4 ? "human" : "agent",
        });
        if (i % 4 === 0) delete row.createdAt;
        else
          row.createdAt = new Date(
            i % 3 === 0
              ? "2026-01-01T00:00:00.000Z"
              : "2025-01-01T00:00:00.000Z"
          );
        if (i % 5 === 0) delete row.confidencePct;
        else row.confidencePct = (i % 3) * 30;
        records.push({
          id: row.id,
          domain: row.domain,
          entryType: row.entryType ?? "finding",
          sourceType: row.sourceType,
          confidencePct: row.confidencePct ?? -1,
          createdAt: row.createdAt?.toISOString() ?? "",
        });
      }
    }
  );
  for (const sort of [
    "id",
    "domain",
    "entryType",
    "sourceType",
    "confidencePct",
    "createdAt",
  ] as const) {
    for (const direction of ["asc", "desc"] as const) {
      const expected = [...records]
        .sort((a, b) => {
          const left = required(a[sort]),
            right = required(b[sort]);
          if (left !== right)
            return (left < right ? -1 : 1) * (direction === "asc" ? 1 : -1);
          return String(a.id) < String(b.id) ? -1 : 1;
        })
        .map((row) => row.id);
      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.browseKnowledge({
          sort,
          direction,
          ...(cursor ? { cursor } : {}),
        });
        found.push(...page.items.map((row) => row.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(found, `${sort} ${direction}`).toEqual(expected);
    }
  }
  const combined = await store.browseKnowledge({
    domains: ["a", "late"],
    entryTypes: ["guide"],
    sourceTypes: ["human"],
    search: "%_",
    sort: "id",
    direction: "asc",
  });
  expect(combined.items.map((row) => row.id)).toEqual(["n-07", "n-21", "n-35"]);
  const first = await store.browseKnowledge({});
  await expect(
    store.overviewKnowledge({ cursor: required(first.nextCursor) })
  ).rejects.toThrow("does not match query");
  for (const changed of [
    { sort: "id" as const },
    { direction: "asc" as const },
    { search: "other" },
    { domains: ["late"] },
    { entryTypes: ["guide"] },
    { sourceTypes: ["agent"] },
  ])
    await expect(
      store.browseKnowledge({ ...changed, cursor: required(first.nextCursor) })
    ).rejects.toThrow("does not match query");
  await expect(store.browseKnowledge({ cursor: "%invalid" })).rejects.toThrow(
    "Invalid browse cursor"
  );
  await expect(
    store.browseKnowledge({ cursor: "%invalid" })
  ).rejects.toBeInstanceOf(KnowledgeBrowseCursorError);
  await expect(
    store.browseKnowledge({
      cursor: required(first.nextCursor),
      sort: "id",
    })
  ).rejects.toBeInstanceOf(KnowledgeBrowseCursorError);
  await expect(
    store.browseKnowledge({ sort: "nope" as never })
  ).rejects.toBeInstanceOf(KnowledgeBrowseQueryError);
});

it("native lookahead is not consumed and search reads exactly one bounded body window", async () => {
  const { DoltgresKnowledgeStoreAdapter } = await import(
    "../src/adapters/doltgres/index.js"
  );
  const rows = Array.from({ length: 21 }, (_, i) => ({
    id: `n-${String(i).padStart(2, "0")}`,
    domain: "test",
    entity_id: null,
    title: "T",
    entry_type: "finding",
    confidence_pct: null,
    source_type: "human",
    created_at: null,
    use_when: null,
    content: "Body",
  }));
  const queries: string[] = [];
  const sql = {
    unsafe: async (query: string) => {
      if (query.includes("dolt_hashof")) return [{ hash: "head-a" }];
      if (query.startsWith("SELECT COUNT(*)")) return [{ total: 0 }];
      queries.push(query);
      return query.includes("id > 'n-19'") ? rows.slice(20) : rows;
    },
  };
  const store = new DoltgresKnowledgeStoreAdapter({ sql: sql as never });
  const first = await store.browseKnowledge({ sort: "id", direction: "asc" });
  const next = await store.browseKnowledge({
    sort: "id",
    direction: "asc",
    cursor: required(first.nextCursor),
  });
  expect(first.items.map((r) => r.id)).toEqual(
    rows.slice(0, 20).map((r) => r.id)
  );
  expect(next.items.map((r) => r.id)).toEqual(["n-20"]);
  await store.browseKnowledge({
    search: "body",
    domains: ["x' OR 1=1 --", "test"],
    sort: "confidencePct",
    direction: "asc",
  });
  expect(queries[2]).toContain("domain IN ('test', 'x'' OR 1=1 --')");
  expect(queries[2]).toContain(
    "ORDER BY COALESCE(confidence_pct, -1) ASC, id ASC LIMIT 20"
  );
  expect(queries[2]).toMatch(/browse_created_at, content FROM knowledge/);
  expect(queries[2]).not.toMatch(/LOWER|ILIKE/);
});

it.each(["asc", "desc"] as const)(
  "seek-aware transport traverses microsecond timestamps and >20 ties (%s); not native SQL execution",
  async (direction) => {
    const { DoltgresKnowledgeStoreAdapter } = await import(
      "../src/adapters/doltgres/index.js"
    );
    // Fixed fixture and independent complete-ID oracle. Date transport deliberately
    // loses precision; the native text column is the only exact cursor source.
    const groups = ["123455", "123456", "123457"];
    const ids = groups.map((_fraction, group) =>
      Array.from(
        { length: 25 },
        (_, i) => `date-${group}-${String(i).padStart(2, "0")}`
      )
    );
    const rows = groups.flatMap((fraction, group) =>
      required(ids[group]).map((id) => ({
        id,
        domain: "test",
        title: "T",
        entry_type: "finding",
        source_type: "human",
        created_at: new Date("2026-01-01T00:00:00.123Z"),
        browse_created_at: `2026-01-01 00:00:00.${fraction}+00`,
      }))
    );
    const expected = (direction === "asc" ? ids : [...ids].reverse()).flat();
    const queries: string[] = [];
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: {
        unsafe: async (query: string) => {
          if (query.includes("dolt_hashof")) return [{ hash: "head-a" }];
          if (query.startsWith("SELECT COUNT(*)")) return [{ total: 0 }];
          queries.push(query);
          expect(query).toContain(
            "CAST(date_trunc('microseconds', created_at) AS TEXT) AS browse_created_at"
          );
          expect(query).toContain(
            `ORDER BY date_trunc('microseconds', created_at) ${direction.toUpperCase()} NULLS ${direction === "asc" ? "FIRST" : "LAST"}, id ASC LIMIT 21`
          );
          // Interpret the emitted seek predicate against exact microsecond keys.
          // This transport fixture tests cursor/control flow, not a SQL engine.
          const seek = query.match(
            /WHERE \(date_trunc\('microseconds', created_at\) ([<>]) '([^']+)' OR \(date_trunc\('microseconds', created_at\) = '([^']+)' AND id > '([^']+)'\)/
          );
          if (query.includes("WHERE")) expect(seek).not.toBeNull();
          const candidates = rows.filter((row) => {
            if (!seek) return true;
            expect(seek[2]).toBe(seek[3]);
            const key = row.browse_created_at
              .replace(" ", "T")
              .replace(/\+00$/, "+00:00");
            const anchor = required(seek[2]);
            return (
              (seek[1] === ">" ? key > anchor : key < anchor) ||
              (key === anchor && row.id > required(seek[4]))
            );
          });
          return candidates
            .sort((a, b) => {
              const primary = a.browse_created_at.localeCompare(
                b.browse_created_at
              );
              return (
                (direction === "asc" ? primary : -primary) ||
                a.id.localeCompare(b.id)
              );
            })
            .slice(0, 21);
        },
      } as never,
    });
    const found: string[] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    let exhausted = false;
    for (let window = 0; window < 6; window++) {
      const result = await store.browseKnowledge({
        direction,
        ...(cursor ? { cursor } : {}),
      });
      found.push(...result.items.map((row) => row.id));
      firstCursor ??= result.nextCursor ?? undefined;
      if (!result.nextCursor) {
        exhausted = true;
        break;
      }
      cursor = result.nextCursor;
    }
    expect(exhausted).toBe(true);
    expect(queries).toHaveLength(4);
    expect(new Set(found).size).toBe(75);
    expect(found).toEqual(expected);
    expect(queries.slice(1).join(" ")).toContain(".123456+00:00");
    const malformed = JSON.parse(decodeURIComponent(required(firstCursor)));
    malformed.value = "not a timestamp";
    await expect(
      store.browseKnowledge({
        direction,
        cursor: encodeURIComponent(JSON.stringify(malformed)),
      })
    ).rejects.toThrow("Invalid browse cursor");
  }
);

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing required fixture value");
  return value;
}

it("native date keysets include the null tail in both directions without sentinel collisions", async () => {
  const { DoltgresKnowledgeStoreAdapter } = await import(
    "../src/adapters/doltgres/index.js"
  );
  const queries: string[] = [];
  const store = new DoltgresKnowledgeStoreAdapter({
    sql: {
      unsafe: async (query: string) => {
        if (query.includes("dolt_hashof")) return [{ hash: "head-a" }];
        if (query.startsWith("SELECT COUNT(*)")) return [{ total: 0 }];
        queries.push(query);
        return Array.from({ length: 21 }, (_, i) => ({
          id: `null-${i}`,
          domain: "t",
          title: "T",
          entry_type: "finding",
          source_type: "human",
          created_at: null,
          browse_created_at: null,
        }));
      },
    } as never,
  });
  for (const direction of ["asc", "desc"] as const) {
    const first = await store.browseKnowledge({ direction });
    await store.browseKnowledge({
      direction,
      cursor: required(first.nextCursor),
    });
  }
  expect(queries[0]).toContain(
    "date_trunc('microseconds', created_at) ASC NULLS FIRST, id ASC"
  );
  expect(queries[1]).toContain(
    "created_at IS NOT NULL OR (created_at IS NULL AND id > 'null-19')"
  );
  expect(queries[2]).toContain(
    "date_trunc('microseconds', created_at) DESC NULLS LAST, id ASC"
  );
  expect(queries[3]).toContain("WHERE (created_at IS NULL AND id > 'null-19')");
  expect(queries.join(" ")).not.toContain("0001-01-01");
});

it("records observed live revisions in both projections, including empty windows", async () => {
  const store = new FakeKnowledgeStoreAdapter();
  const before = await store.browseKnowledge({});
  await store.registerDomain({ id: "revision", name: "Revision" });
  await store.withWrite(
    { operationId: "revision", message: "change" },
    async (write) => {
      await write.addKnowledge({
        id: "changed",
        domain: "revision",
        title: "Changed",
        content: "body",
        sourceType: "human",
      });
    }
  );
  const after = await store.overviewKnowledge({});
  expect(after.revision).not.toBe(before.revision);
  expect((await store.browseKnowledge({ search: "absent" })).revision).toBe(
    after.revision
  );
});

it("bounds native work after timeout/abort across adapters, preserves unrelated readers and recovers only after settlement", async () => {
  vi.useFakeTimers();
  try {
    const { DoltgresKnowledgeStoreAdapter } = await import(
      "../src/adapters/doltgres/index.js"
    );
    const pending: Array<(rows: Array<Record<string, unknown>>) => void> = [];
    const sql = {
      options: { max: 2 },
      end: vi.fn(),
      unsafe: vi.fn((query: string) => {
        if (query === "SELECT unrelated")
          return Promise.resolve([{ ok: true }]);
        if (query.includes("dolt_hashof"))
          return Promise.resolve([{ hash: "head-real" }]);
        return new Promise<Array<Record<string, unknown>>>((resolve) =>
          pending.push(resolve)
        );
      }),
    };
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: sql as never,
      browseTimeoutMs: 50,
    });
    const sibling = new DoltgresKnowledgeStoreAdapter({
      sql: sql as never,
      browseTimeoutMs: 50,
    });
    const failed = expect(
      store.browseKnowledge({ search: "body" })
    ).rejects.toMatchObject({ code: "KNOWLEDGE_BUSY", retryable: true });
    await vi.advanceTimersByTimeAsync(50);
    await failed;
    expect(pending).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      const rejected = expect(
        sibling.overviewKnowledge({}, { signal: controller.signal })
      ).rejects.toMatchObject({ retryable: true });
      controller.abort();
      await rejected;
    }
    const queuedFailure = expect(
      sibling.browseKnowledge({})
    ).rejects.toMatchObject({ retryable: true });
    await vi.advanceTimersByTimeAsync(50);
    await queuedFailure;
    expect(pending).toHaveLength(1);
    expect(await sql.unsafe("SELECT unrelated")).toEqual([{ ok: true }]);
    expect(sql.end).not.toHaveBeenCalled();
    pending[0]?.([]);
    await vi.advanceTimersByTimeAsync(0);
    const recovered = store.overviewKnowledge({});
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(2);
    pending[1]?.([]);
    // The exact total is a second bounded read inside the same budget.
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(3);
    pending[2]?.([{ total: 0 }]);
    await expect(recovered).resolves.toEqual({
      revision: "head-real",
      items: [],
      nextCursor: null,
      scannedRows: 0,
      total: 0,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("quarantines unknown transport outcomes for a bounded time, then recovers", async () => {
  vi.useFakeTimers();
  try {
    const { DoltgresKnowledgeStoreAdapter } = await import(
      "../src/adapters/doltgres/index.js"
    );
    let rejectNative: (error: Error) => void = () => undefined;
    let healthy = false;
    const sql = {
      options: { max: 2 },
      unsafe: vi.fn(async (text: string) => {
        if (healthy)
          return text.includes("dolt_hashof") ? [{ hash: "head-ok" }] : [];
        return new Promise<never>((_, reject) => {
          rejectNative = reject;
        });
      }),
    };
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: sql as never,
      browseTimeoutMs: 25,
    });
    const controller = new AbortController();
    const rejected = expect(
      store.browseKnowledge({}, { signal: controller.signal })
    ).rejects.toMatchObject({ retryable: true });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    rejectNative(
      Object.assign(new Error("connection lost; backend outcome unknown"), {
        code: "EPIPE",
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    const deadline = expect(store.overviewKnowledge({})).rejects.toMatchObject({
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(25);
    await deadline;
    expect(sql.unsafe).toHaveBeenCalledTimes(1);
    // Quarantine is 4x the 25ms deadline; 25ms already elapsed in the wait above.
    healthy = true;
    await vi.advanceTimersByTimeAsync(75);
    const recovered = store.overviewKnowledge({});
    await vi.advanceTimersByTimeAsync(0);
    await expect(recovered).resolves.toMatchObject({ revision: "head-ok" });
  } finally {
    vi.useRealTimers();
  }
});

it("releases the permit at once on definitive closed-connection errors", async () => {
  const { DoltgresKnowledgeStoreAdapter } = await import(
    "../src/adapters/doltgres/index.js"
  );
  for (const code of [
    "CONNECTION_CLOSED",
    "ECONNRESET",
    "ECONNREFUSED",
  ] as const) {
    let fail = true;
    const sql = {
      options: { max: 2 },
      unsafe: async (text: string) => {
        if (fail) {
          fail = false;
          throw Object.assign(new Error("transport closed"), { code });
        }
        return text.includes("dolt_hashof") ? [{ hash: "head-b" }] : [];
      },
    };
    const store = new DoltgresKnowledgeStoreAdapter({ sql: sql as never });
    await expect(store.browseKnowledge({})).rejects.toMatchObject({
      retryable: true,
    });
    await expect(store.overviewKnowledge({})).resolves.toMatchObject({
      revision: "head-b",
    });
  }
});

it("caps waiting callers and recycles acknowledged SQL errors without poisoning healthy reads", async () => {
  const { DoltgresKnowledgeStoreAdapter } = await import(
    "../src/adapters/doltgres/index.js"
  );
  let fail = true;
  const sql = {
    options: { max: 2 },
    unsafe: async (text: string) => {
      if (text.includes("dolt_hashof")) return [{ hash: "head-a" }];
      if (fail) {
        fail = false;
        throw Object.assign(new Error("server rejected query"), {
          name: "PostgresError",
          code: "57014",
        });
      }
      return [];
    },
  };
  const store = new DoltgresKnowledgeStoreAdapter({ sql: sql as never });
  await expect(store.browseKnowledge({})).rejects.toMatchObject({
    retryable: true,
  });
  await expect(store.overviewKnowledge({})).resolves.toMatchObject({
    revision: "head-a",
    items: [],
  });
  vi.useFakeTimers();
  try {
    const stalledSql = {
      options: { max: 2 },
      unsafe: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const stalled = new DoltgresKnowledgeStoreAdapter({
      sql: stalledSql as never,
      browseTimeoutMs: 30,
    });
    const first = expect(stalled.browseKnowledge({})).rejects.toMatchObject({
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const controllers = Array.from({ length: 32 }, () => new AbortController());
    const waiting = controllers.map((controller) =>
      expect(
        stalled.overviewKnowledge({}, { signal: controller.signal })
      ).rejects.toMatchObject({ retryable: true })
    );
    await expect(stalled.browseKnowledge({})).rejects.toMatchObject({
      retryable: true,
    });
    controllers.forEach((controller) => {
      controller.abort();
    });
    await Promise.all(waiting);
    await vi.advanceTimersByTimeAsync(30);
    await first;
    expect(stalledSql.unsafe).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("reports the exact filtered total on every window, unchanged by the cursor or a search", async () => {
  const store = new FakeKnowledgeStoreAdapter();
  for (const id of ["a", "b"]) await store.registerDomain({ id, name: id });
  await store.withWrite(
    { operationId: "total-fixture", message: "fixture" },
    async (write) => {
      for (let i = 0; i < 45; i++)
        await write.addKnowledge({
          id: `t-${String(i).padStart(2, "0")}`,
          domain: i < 30 ? "a" : "b",
          title: "T",
          content: i === 44 ? "needle" : "body",
          sourceType: "human",
        });
    }
  );
  const all = await store.browseKnowledge({ sort: "id", direction: "asc" });
  expect(all.total).toBe(45);
  const next = await store.browseKnowledge({
    sort: "id",
    direction: "asc",
    cursor: required(all.nextCursor),
  });
  expect(next.total).toBe(45);
  expect((await store.browseKnowledge({ domains: ["b"] })).total).toBe(15);
  expect((await store.overviewKnowledge({ domains: ["a"] })).total).toBe(30);
  expect((await store.browseKnowledge({ domains: ["missing"] })).total).toBe(0);
  // With a search, total is the candidate set the search walks.
  expect((await store.browseKnowledge({ search: "needle" })).total).toBe(45);
});

it("counts the native total with the filters only, never the seek predicate", async () => {
  const { DoltgresKnowledgeStoreAdapter } = await import(
    "../src/adapters/doltgres/index.js"
  );
  const counts: string[] = [];
  const rows = Array.from({ length: 21 }, (_, i) => ({
    id: `n-${String(i).padStart(2, "0")}`,
    domain: "test",
    entity_id: null,
    title: "T",
    entry_type: "finding",
    confidence_pct: null,
    source_type: "human",
    created_at: null,
    use_when: null,
  }));
  const sql = {
    unsafe: async (query: string) => {
      if (query.includes("dolt_hashof")) return [{ hash: "head-a" }];
      if (query.startsWith("SELECT COUNT(*)")) {
        counts.push(query);
        return [{ total: "137" }];
      }
      return rows;
    },
  };
  const store = new DoltgresKnowledgeStoreAdapter({ sql: sql as never });
  const first = await store.browseKnowledge({
    sort: "id",
    direction: "asc",
    domains: ["test"],
  });
  const next = await store.browseKnowledge({
    sort: "id",
    direction: "asc",
    domains: ["test"],
    cursor: required(first.nextCursor),
  });
  expect([first.total, next.total]).toEqual([137, 137]);
  expect(counts).toEqual([
    "SELECT COUNT(*) AS total FROM knowledge WHERE domain IN ('test')",
    "SELECT COUNT(*) AS total FROM knowledge WHERE domain IN ('test')",
  ]);
});
