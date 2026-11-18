// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/inbox-state`
 * Purpose: Pins the inbox-state read behind the work-items `InboxStatePort` (task.0122): head, merged, open; an unknown inbox is null.
 * Scope: Fake `sql.unsafe` only. No database.
 * Invariants:
 *   - The read is one SELECT of `state` and `head_commit` by escaped inbox id.
 *   - An aborted signal rejects the call at once, even while the query is in flight.
 *   - A failed read throws; it is never `null`.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import { createDoltgresInboxStates } from "../src/adapters/doltgres/inbox-state.js";

describe("createDoltgresInboxStates", () => {
  it("says merged, open or closed without merging, by escaped id, and an unknown inbox is null", async () => {
    const queries: string[] = [];
    const states = createDoltgresInboxStates({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes("'contrib-open'")) return [{ state: "open", head_commit: "h1" }];
        if (query.includes("'contrib-merged'")) return [{ state: "merged", head_commit: "h2" }];
        if (query.includes("'contrib-closed'")) return [{ state: "closed", head_commit: null }];
        return [];
      },
    });
    const signal = new AbortController().signal;
    expect(await states.stateOf("contrib-open", signal)).toEqual({ head: "h1", merged: false });
    expect(await states.stateOf("contrib-merged", signal)).toEqual({ head: "h2", merged: true });
    expect(await states.stateOf("contrib-closed", signal)).toEqual({ head: null, merged: false });
    expect(await states.stateOf("contrib-none", signal)).toBeNull();
    expect(queries[0]).toBe(
      "SELECT state, head_commit FROM knowledge_contributions WHERE id = 'contrib-open' LIMIT 1"
    );
    await states.stateOf("x'; DROP TABLE t; --", signal);
    expect(queries[4]).toContain("'x''; DROP TABLE t; --'");
  });

  it("rejects at the signal while the query hangs, and when it is already aborted", async () => {
    const states = createDoltgresInboxStates({ unsafe: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = states.stateOf("contrib-a", controller.signal);
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    await expect(states.stateOf("contrib-a", controller.signal)).rejects.toThrow();
  });

  it("throws when the read fails", async () => {
    const states = createDoltgresInboxStates({
      unsafe: async () => {
        throw new Error("down");
      },
    });
    await expect(states.stateOf("contrib-a", new AbortController().signal)).rejects.toThrow("down");
  });
});
