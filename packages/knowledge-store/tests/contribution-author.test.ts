// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/contribution-author`
 * Purpose: Pins the inbox-author read behind the work-items `ContributionAuthorPort` (task.0028).
 * Scope: Fake `sql.unsafe` only. No database.
 * Invariants:
 *   - The read is one SELECT of `principal_id` by escaped inbox id; an unknown inbox is `null`.
 *   - An aborted signal rejects the call at once, even while the query is in flight.
 *   - A failed read throws; it is never `null`.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import { createDoltgresContributionAuthors } from "../src/adapters/doltgres/contribution-author.js";

describe("createDoltgresContributionAuthors", () => {
  it("reads principal_id by escaped id, and an unknown inbox is null", async () => {
    const queries: string[] = [];
    const authors = createDoltgresContributionAuthors({
      unsafe: async (query) => {
        queries.push(query);
        return query.includes("'contrib-a'") ? [{ principal_id: "author-1" }] : [];
      },
    });
    const signal = new AbortController().signal;
    expect(await authors.principalOf("contrib-a", signal)).toBe("author-1");
    expect(await authors.principalOf("contrib-b", signal)).toBeNull();
    expect(await authors.principalOf("x'; DROP TABLE t; --", signal)).toBeNull();
    expect(queries[0]).toBe(
      "SELECT principal_id FROM knowledge_contributions WHERE id = 'contrib-a' LIMIT 1"
    );
    expect(queries[2]).toContain("'x''; DROP TABLE t; --'");
  });

  it("stateOf reads the inbox head and says merged, open or closed without merging (task.0122)", async () => {
    const authors = createDoltgresContributionAuthors({
      unsafe: async (query) => {
        if (query.includes("'contrib-open'")) return [{ state: "open", head_commit: "h1" }];
        if (query.includes("'contrib-merged'")) return [{ state: "merged", head_commit: "h2" }];
        if (query.includes("'contrib-closed'")) return [{ state: "closed", head_commit: null }];
        return [];
      },
    });
    const signal = new AbortController().signal;
    expect(await authors.stateOf("contrib-open", signal)).toEqual({ head: "h1", merged: false, open: true });
    expect(await authors.stateOf("contrib-merged", signal)).toEqual({ head: "h2", merged: true, open: false });
    expect(await authors.stateOf("contrib-closed", signal)).toEqual({ head: null, merged: false, open: false });
    expect(await authors.stateOf("contrib-none", signal)).toBeNull();
  });

  it("rejects at the signal while the query hangs, and when it is already aborted", async () => {
    const authors = createDoltgresContributionAuthors({
      unsafe: () => new Promise(() => {}),
    });
    const controller = new AbortController();
    const pending = authors.principalOf("contrib-a", controller.signal);
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    await expect(authors.principalOf("contrib-a", controller.signal)).rejects.toThrow();
  });

  it("throws when the read fails", async () => {
    const authors = createDoltgresContributionAuthors({
      unsafe: async () => {
        throw new Error("down");
      },
    });
    await expect(
      authors.principalOf("contrib-a", new AbortController().signal)
    ).rejects.toThrow("down");
  });
});
