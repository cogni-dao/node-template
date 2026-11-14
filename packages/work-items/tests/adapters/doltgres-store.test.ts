// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-store`
 * Purpose: Proves `createDoltgresWorkItemStore` makes the cite and moves wiring an explicit choice (task.0097).
 * Scope: Fake `Sql` over one in-memory row. No real database.
 * Invariants:
 *   - WIRING_IS_A_CHOICE: omitting either option throws at construction; `null` is allowed.
 *   - RESOLVER_REACHES_THE_ADAPTER: a port passed to the factory runs on a cited patch; `null` gives `cites_unsupported`.
 *   - BASELINE_NEEDS_A_RESOLVER: a baseline port with no resolver throws at construction.
 *   - MOVES_NEED_BOTH: with a resolver and no baseline port a non-empty `moves` write is `moves_unsupported`.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  DoltgresWorkItemAdapter,
  type DoltgresWorkItemStoreOptions,
  createDoltgresWorkItemStore,
} from "../../src/adapters/doltgres/index.js";
import type { EntryResolver } from "../../src/cites.js";
import type { MetricBaselinePort } from "../../src/moves.js";
import { toWorkItemId } from "../../src/types.js";
import { independentReadPool, makeFakeDoltgresSql } from "./fake-doltgres-sql.js";

const ID = "task.0001";
const PRINCIPAL = "principal-1";
const COMMIT = "a".repeat(32);
const row = {
  id: ID,
  type: "task",
  title: "t",
  status: "needs_implement",
  node: "n",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  revision: 3,
  deploy_verified: false,
  created_by_principal_id: PRINCIPAL,
  claimed_by_run: null,
  claimed_at: null,
  claim_owner_principal_id: null,
  claim_expires_at: null,
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
};

function build(wiring: Pick<DoltgresWorkItemStoreOptions, "entryResolver" | "metricBaseline">) {
  const queries: string[] = [];
  let current: Record<string, unknown> = { ...row };
  const sql = makeFakeDoltgresSql((query) => {
    if (query.startsWith("SELECT id FROM work_items")) return [];
    if (query.startsWith("UPDATE work_items")) {
      current = { ...current, revision: Number(current.revision) + 1, claim_active: false };
      const title = /\btitle = '([^']*)'/.exec(query)?.[1];
      if (title !== undefined) current.title = title;
      const moves = /\bmoves = '(.*?)'::jsonb/.exec(query)?.[1];
      if (moves !== undefined) current.moves = JSON.parse(moves.replace(/''/g, "'"));
      return [current];
    }
    if (/FROM work_items WHERE id = '([^']+)'/.test(query)) return [{ ...current, claim_active: false }];
    return [];
  }, queries);
  return createDoltgresWorkItemStore(sql, {
    readClient: independentReadPool(sql),
    recreateClient: () => sql,
    prFacts: null,
    inboxes: null,
    ...wiring,
  });
}

const patch = (store: DoltgresWorkItemAdapter, extra: Record<string, unknown>) =>
  store.patch(
    { id: toWorkItemId(ID), reason: "why", set: { title: "u" }, ...extra } as never,
    PRINCIPAL,
  );

const baseline: MetricBaselinePort = { latestObservationId: async () => null };

describe("createDoltgresWorkItemStore", () => {
  it("builds the package adapter", () => {
    expect(build({ entryResolver: null, metricBaseline: null })).toBeInstanceOf(DoltgresWorkItemAdapter);
  });

  it("throws when a wiring option is omitted, even through a cast", () => {
    const sql = makeFakeDoltgresSql(() => []);
    expect(() => createDoltgresWorkItemStore(sql, { metricBaseline: null } as never)).toThrow(TypeError);
    expect(() => createDoltgresWorkItemStore(sql, { entryResolver: null } as never)).toThrow(TypeError);
    expect(() => createDoltgresWorkItemStore(sql, {} as never)).toThrow(/entryResolver and metricBaseline/);
    // task.0122: the status gates read PR and inbox facts, so those are a choice too.
    expect(() =>
      createDoltgresWorkItemStore(sql, { entryResolver: null, metricBaseline: null } as never)
    ).toThrow(/prFacts and inboxes/);
  });

  it("throws when a baseline port has no resolver", () => {
    expect(() => build({ entryResolver: null, metricBaseline: baseline })).toThrow(/needs an entryResolver/);
  });

  it("passes the resolver to the adapter: a cited patch calls it with rule cite", async () => {
    const resolve = vi.fn<EntryResolver["resolve"]>(async (refs) =>
      refs.map((r) => ({ id: r.id, commit: COMMIT, plane: "main" as const })),
    );
    const store = build({ entryResolver: { resolve }, metricBaseline: null });
    await patch(store, { cites: [{ id: "change-history-design" }] });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[1]).toBe("cite");
  });

  it("with no resolver a cited patch is refused as cites_unsupported, and a reason alone still works", async () => {
    const store = build({ entryResolver: null, metricBaseline: null });
    await expect(patch(store, { cites: [{ id: "change-history-design" }] })).rejects.toMatchObject({
      name: "CitesUnsupportedError",
    });
    await expect(patch(store, {})).resolves.toMatchObject({ id: ID });
  });

  it("with a resolver and no baseline port a non-empty moves write is moves_unsupported", async () => {
    const resolve = vi.fn<EntryResolver["resolve"]>(async () => []);
    const store = build({ entryResolver: { resolve }, metricBaseline: null });
    await expect(
      patch(store, { set: { moves: [{ metricId: "m-1", direction: "up" }] } }),
    ).rejects.toMatchObject({ name: "MovesUnsupportedError" });
    await expect(patch(store, { set: { title: "u", moves: [] } })).resolves.toMatchObject({ id: ID });
    expect(resolve).not.toHaveBeenCalled();
  });
});
