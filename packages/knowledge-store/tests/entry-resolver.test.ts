// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/entry-resolver`
 * Purpose: Pins the cite resolver: what it reads, what it pins, and what it refuses (task.0086).
 * Scope: `createDoltgresEntryResolver` over a fake SQL executor. No database.
 * Invariants:
 *   - NO_CHECKOUT / NO_DOLT_DIFF: no query mentions `dolt_checkout` or `dolt_diff(`.
 *   - PIN_MATCHES_READ: a main pin is the hash the id read used; an inbox pin is the open head the id read used.
 *   - UNRESOLVED_IS_BY_ID: an unknown id, a closed inbox, or an inbox without the id lists those ids.
 * Side-effects: none
 * Links: hub change-history-design
 */

import { describe, expect, it } from "vitest";

import { createDoltgresEntryResolver } from "../src/adapters/doltgres/entry-resolver.js";
import { EntryUnresolvedError } from "../src/port/entry-resolver.port.js";

const MAIN = "a".repeat(32);
const HEAD_OPEN = "0123456789abcdefghijklmnopqrstuv";
const HEAD_OTHER = "b".repeat(32);

interface World {
  main: string[];
  /** Ids on main that hold a metric spec and are not deprecated (story.0033). */
  metrics?: string[];
  inboxes: Record<string, { state: string; head: string | null; ids: string[] }>;
}

function fakeSql(world: World) {
  const queries: string[] = [];
  const unsafe = async (query: string) => {
    queries.push(query);
    if (query.startsWith("SELECT dolt_hashof('main')")) return [{ hash: MAIN }];
    const metric =
      /^SELECT id FROM knowledge AS OF '([^']+)' WHERE id IN \((.*)\) AND metric_spec IS NOT NULL AND status <> 'deprecated'$/.exec(
        query
      );
    if (metric) {
      const [, commit, list] = metric;
      const asked = [...(list as string).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1] as string);
      const held = commit === MAIN ? (world.metrics ?? []) : [];
      return asked.filter((id) => held.includes(id)).map((id) => ({ id }));
    }
    const asOf = /^SELECT id FROM knowledge AS OF '([^']+)' WHERE id IN \((.*)\)$/.exec(query);
    if (asOf) {
      const [, commit, list] = asOf;
      const asked = [...(list as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
      const held =
        commit === MAIN
          ? world.main
          : (Object.values(world.inboxes).find((i) => i.head === commit)?.ids ?? []);
      return asked.filter((id) => held.includes(id)).map((id) => ({ id }));
    }
    if (query.startsWith("SELECT id, state, head_commit FROM knowledge_contributions")) {
      const asked = [...query.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
      return asked
        .filter((id) => world.inboxes[id])
        .map((id) => ({
          id,
          state: world.inboxes[id]?.state,
          head_commit: world.inboxes[id]?.head,
        }));
    }
    throw new Error(`unexpected query: ${query}`);
  };
  return { sql: { unsafe }, queries };
}

const signal = () => new AbortController().signal;

describe("createDoltgresEntryResolver", () => {
  const world = (): World => ({
    main: ["change-history-design", "node-template-mission"],
    inboxes: {
      "contrib-open": { state: "open", head: HEAD_OPEN, ids: ["inbox-only", "change-history-design"] },
      "contrib-merged": { state: "merged", head: HEAD_OTHER, ids: ["merged-atom"] },
      "contrib-empty": { state: "open", head: null, ids: [] },
    },
  });

  it("pins a main id to the hash the read used", async () => {
    const { sql, queries } = fakeSql(world());
    const out = await createDoltgresEntryResolver(sql).resolve(
      [{ id: "change-history-design" }, { id: "node-template-mission" }],
      "cite",
      signal()
    );
    expect(out).toEqual([
      { id: "change-history-design", commit: MAIN, plane: "main" },
      { id: "node-template-mission", commit: MAIN, plane: "main" },
    ]);
    expect(queries[0]).toBe("SELECT dolt_hashof('main') AS hash");
    expect(queries[1]).toContain(`AS OF '${MAIN}'`);
  });

  it("pins an inbox id to the open contribution's head commit", async () => {
    const { sql } = fakeSql(world());
    const out = await createDoltgresEntryResolver(sql).resolve(
      [{ id: "inbox-only", contribution: "contrib-open" }],
      "cite",
      signal()
    );
    expect(out).toEqual([
      { id: "inbox-only", commit: HEAD_OPEN, plane: "inbox", contribution: "contrib-open" },
    ]);
  });

  it("resolves a mix of main and inbox cites, up to eight", async () => {
    const { sql } = fakeSql(world());
    const out = await createDoltgresEntryResolver(sql).resolve(
      [
        { id: "change-history-design" },
        { id: "inbox-only", contribution: "contrib-open" },
        { id: "node-template-mission" },
      ],
      "cite",
      signal()
    );
    expect(out.map((r) => [r.id, r.plane])).toEqual([
      ["change-history-design", "main"],
      ["node-template-mission", "main"],
      ["inbox-only", "inbox"],
    ]);
  });

  it.each([
    ["an unknown id", [{ id: "ghost" }], ["ghost"]],
    ["an id that exists only in an inbox, cited as main", [{ id: "inbox-only" }], ["inbox-only"]],
    ["a merged (closed) inbox", [{ id: "merged-atom", contribution: "contrib-merged" }], ["merged-atom"]],
    ["an unknown inbox", [{ id: "x-1", contribution: "contrib-nope" }], ["x-1"]],
    ["an inbox with no commits", [{ id: "x-2", contribution: "contrib-empty" }], ["x-2"]],
    ["an open inbox without the id", [{ id: "ghost", contribution: "contrib-open" }], ["ghost"]],
  ])("%s is EntryUnresolvedError by id", async (_name, refs, ids) => {
    const { sql } = fakeSql(world());
    const attempt = createDoltgresEntryResolver(sql).resolve(refs, "cite", signal());
    await expect(attempt).rejects.toBeInstanceOf(EntryUnresolvedError);
    await expect(attempt).rejects.toMatchObject({ ids });
  });

  it("lists every unresolved id, not only the first", async () => {
    const { sql } = fakeSql(world());
    await expect(
      createDoltgresEntryResolver(sql).resolve(
        [{ id: "ghost-a" }, { id: "change-history-design" }, { id: "ghost-b" }],
        "cite",
        signal()
      )
    ).rejects.toMatchObject({ ids: ["ghost-a", "ghost-b"] });
  });

  it("never checks out a branch or reads dolt_diff()", async () => {
    const { sql, queries } = fakeSql(world());
    await createDoltgresEntryResolver(sql).resolve(
      [{ id: "change-history-design" }, { id: "inbox-only", contribution: "contrib-open" }],
      "cite",
      signal()
    );
    expect(queries.join("\n")).not.toMatch(/dolt_checkout|dolt_diff\(/);
  });

  it("escapes ids and refuses a head that is not a commit hash", async () => {
    const w = world();
    w.inboxes["contrib-open"] = { state: "open", head: "x'; DROP TABLE knowledge; --", ids: [] };
    const { sql, queries } = fakeSql(w);
    await expect(
      createDoltgresEntryResolver(sql).resolve(
        [{ id: "inbox-only", contribution: "contrib-open" }],
        "cite",
        signal()
      )
    ).rejects.toThrow(/not a Dolt commit hash/);
    expect(queries.some((q) => q.includes("DROP TABLE"))).toBe(false);

    const quote = fakeSql(world());
    await expect(
      createDoltgresEntryResolver(quote.sql).resolve([{ id: "a'b" }], "cite", signal())
    ).rejects.toBeInstanceOf(EntryUnresolvedError);
    expect(quote.queries[1]).toContain("'a''b'");
  });

  it("stops when the signal is aborted", async () => {
    const { sql, queries } = fakeSql(world());
    const controller = new AbortController();
    controller.abort();
    await expect(
      createDoltgresEntryResolver(sql).resolve([{ id: "change-history-design" }], "cite", controller.signal)
    ).rejects.toThrow();
    expect(queries).toHaveLength(0);
  });

  it("refuses an unknown rule", async () => {
    const { sql } = fakeSql(world());
    await expect(
      createDoltgresEntryResolver(sql).resolve([], "other" as never, signal())
    ).rejects.toThrow(/rule/);
  });

  describe("rule metric (story.0033)", () => {
    const metricWorld = (): World => ({
      ...world(),
      metrics: ["convergence-ratio", "deploy-first-try-7d"],
    });

    it("pins a registered metric on main to the hash the read used", async () => {
      const { sql, queries } = fakeSql(metricWorld());
      const out = await createDoltgresEntryResolver(sql).resolve(
        [{ id: "convergence-ratio" }, { id: "deploy-first-try-7d" }],
        "metric",
        signal()
      );
      expect(out).toEqual([
        { id: "convergence-ratio", commit: MAIN, plane: "main" },
        { id: "deploy-first-try-7d", commit: MAIN, plane: "main" },
      ]);
      expect(queries[0]).toBe("SELECT dolt_hashof('main') AS hash");
      expect(queries[1]).toContain(`AS OF '${MAIN}'`);
      expect(queries[1]).toContain("metric_spec IS NOT NULL");
      expect(queries[1]).toContain("status <> 'deprecated'");
    });

    it.each([
      // An atom with no metric spec, a deprecated metric and an absent id all read as not in the live set.
      ["an atom that holds no metric spec", [{ id: "change-history-design" }], ["change-history-design"]],
      ["a deprecated metric", [{ id: "old-deprecated-metric" }], ["old-deprecated-metric"]],
      ["an unknown id", [{ id: "ghost" }], ["ghost"]],
      ["an inbox ref, which has no meaning for a metric", [{ id: "convergence-ratio", contribution: "contrib-open" }], ["convergence-ratio"]],
    ])("%s is EntryUnresolvedError by id", async (_name, refs, ids) => {
      const { sql } = fakeSql(metricWorld());
      const attempt = createDoltgresEntryResolver(sql).resolve(refs, "metric", signal());
      await expect(attempt).rejects.toBeInstanceOf(EntryUnresolvedError);
      await expect(attempt).rejects.toMatchObject({ ids });
    });

    it("lists every unresolved id and still pins none", async () => {
      const { sql } = fakeSql(metricWorld());
      await expect(
        createDoltgresEntryResolver(sql).resolve(
          [{ id: "ghost-a" }, { id: "convergence-ratio" }, { id: "ghost-b" }],
          "metric",
          signal()
        )
      ).rejects.toMatchObject({ ids: ["ghost-a", "ghost-b"] });
    });

    it("reads only dolt_hashof and AS OF: no checkout, no dolt_diff()", async () => {
      const { sql, queries } = fakeSql(metricWorld());
      await createDoltgresEntryResolver(sql).resolve([{ id: "convergence-ratio" }], "metric", signal());
      expect(queries.join("\n")).not.toMatch(/dolt_checkout|dolt_diff\(/);
    });

    it("escapes the id and stops on an aborted signal", async () => {
      const quote = fakeSql(metricWorld());
      await expect(
        createDoltgresEntryResolver(quote.sql).resolve([{ id: "a'b" }], "metric", signal())
      ).rejects.toBeInstanceOf(EntryUnresolvedError);
      expect(quote.queries[1]).toContain("'a''b'");

      const { sql, queries } = fakeSql(metricWorld());
      const controller = new AbortController();
      controller.abort();
      await expect(
        createDoltgresEntryResolver(sql).resolve([{ id: "convergence-ratio" }], "metric", controller.signal)
      ).rejects.toThrow();
      expect(queries).toHaveLength(0);
    });
  });
});
