import { expect, it } from "vitest";
import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";

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
