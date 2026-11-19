// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/attribution/tests/epoch-views`
 * Purpose: Package-only proof of the epoch read views against an in-memory store.
 * Scope: Unit tests. No database.
 * Invariants: PURE_READ_VIEWS (resolution returns pending updates, never writes), NODE_SCOPED,
 *   BOUNDED_READS (only the page's receipts are resolved).
 * Side-effects: none
 * Links: src/read/epoch-views.ts, operator bug.5647
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildEpochActivityView,
  EPOCH_PAGE_MAX_LIMIT,
  type EpochReadStore,
  listEpochsView,
  persistSelectionUpdates,
} from "../src/index";
import type {
  AttributionEpoch,
  AttributionSelection,
  IngestionReceipt,
} from "../src/store";

const NODE = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const OTHER_NODE = "f66b260b-4633-41e2-8711-b7c1b8449cc1";

function epoch(id: bigint, nodeId = NODE): AttributionEpoch {
  return {
    id,
    nodeId,
    scopeId: "scope",
    status: "open",
    periodStart: new Date("2026-11-16T00:00:00.000Z"),
    periodEnd: new Date("2026-11-23T00:00:00.000Z"),
    weightConfig: { "github:pr_merged": 1000 },
    poolTotalCredits: null,
    approvers: null,
    approverSetHash: null,
    allocationAlgoRef: null,
    weightConfigHash: null,
    artifactsHash: null,
    openedAt: new Date("2026-11-16T00:00:00.000Z"),
    closedAt: null,
    createdAt: new Date("2026-11-16T00:00:00.000Z"),
  } as AttributionEpoch;
}

function receipt(receiptId: string, platformUserId: string): IngestionReceipt {
  return {
    receiptId,
    nodeId: NODE,
    source: "github",
    eventType: "pr_merged",
    platformUserId,
    platformLogin: `login-${platformUserId}`,
    artifactUrl: `https://github.com/cogni-dao/node-template/pull/${receiptId}`,
    metadata: {},
    payloadHash: "h",
    producer: "test",
    producerVersion: "1",
    eventTime: new Date("2026-11-17T00:00:00.000Z"),
    retrievedAt: new Date("2026-11-17T00:00:00.000Z"),
  } as IngestionReceipt;
}

function selection(receiptId: string, userId: string | null) {
  return {
    nodeId: NODE,
    epochId: 7n,
    receiptId,
    userId,
    included: true,
    weightOverrideMilli: null,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AttributionSelection;
}

function store(overrides: Partial<EpochReadStore> = {}): EpochReadStore {
  const receipts = [receipt("1", "100"), receipt("2", "200"), receipt("3", "300")];
  return {
    getEpoch: async (id) => (id === 7n ? epoch(7n) : null),
    listEpochsPage: async (_node, page) => ({
      epochs: [epoch(1n), epoch(2n), epoch(3n)].slice(
        page.offset,
        page.offset + page.limit
      ),
      total: 3,
    }),
    getEpochActivityPage: async (_n, _e, _w, page) => ({
      receipts: receipts.slice(page.offset, page.offset + page.limit),
      total: receipts.length,
    }),
    getSelectionForReceipts: async (_e, ids) =>
      [selection("1", null), selection("2", "user-b"), selection("3", null)].filter(
        (s) => ids.includes(s.receiptId)
      ),
    resolveIdentities: async (_p, ids) =>
      new Map(ids.filter((i) => i === "100").map((i) => [i, "user-a"])),
    ...overrides,
  };
}

describe("buildEpochActivityView", () => {
  it("returns resolved identities as pending updates, with no write (bug.5647 class)", async () => {
    const result = await buildEpochActivityView(store(), NODE, 7n, "7", {
      limit: 10,
      offset: 0,
    });
    expect(result).not.toBeNull();
    expect(result?.view.total).toBe(3);
    expect(result?.view.epochId).toBe("7");
    expect(result?.view.events.map((e) => e.selection?.userId)).toEqual([
      "user-a",
      "user-b",
      null,
    ]);
    expect(result?.pendingSelectionUpdates).toEqual([
      { epochId: 7n, receiptId: "1", userId: "user-a" },
    ]);
    expect(result?.resolvedCount).toBe(1);
    expect(result?.unresolvedCount).toBe(1);
  });

  it("resolves only the page's identities", async () => {
    const resolveIdentities = vi.fn(async () => new Map<string, string>());
    const result = await buildEpochActivityView(
      store({ resolveIdentities }),
      NODE,
      7n,
      "7",
      { limit: 1, offset: 2 }
    );
    expect(result?.view.events.map((e) => e.receiptId)).toEqual(["3"]);
    expect(result?.view.total).toBe(3);
    expect(resolveIdentities).toHaveBeenCalledWith("github", ["300"]);
  });

  it("reads an epoch of another node as not found", async () => {
    const result = await buildEpochActivityView(
      store({ getEpoch: async () => epoch(7n, OTHER_NODE) }),
      NODE,
      7n,
      "7",
      { limit: 10, offset: 0 }
    );
    expect(result).toBeNull();
  });

  it("returns null for a missing epoch", async () => {
    expect(
      await buildEpochActivityView(store(), NODE, 99n, "99", {
        limit: 10,
        offset: 0,
      })
    ).toBeNull();
  });
});

describe("page clamp", () => {
  it("never asks the store for more than EPOCH_PAGE_MAX_LIMIT rows", async () => {
    const listEpochsPage = vi.fn(async () => ({ epochs: [], total: 0 }));
    await listEpochsView({ listEpochsPage }, NODE, {
      limit: 10_000,
      offset: -5,
    });
    expect(listEpochsPage).toHaveBeenCalledWith(
      NODE,
      { limit: EPOCH_PAGE_MAX_LIMIT, offset: 0 },
      undefined
    );
  });
});

describe("listEpochsView", () => {
  it("maps one page to DTOs and keeps the total", async () => {
    const view = await listEpochsView(store(), NODE, { limit: 2, offset: 1 });
    expect(view.total).toBe(3);
    expect(view.epochs.map((e) => e.id)).toEqual(["2", "3"]);
    expect(view.epochs[0]?.periodStart).toBe("2026-11-16T00:00:00.000Z");
  });
});

describe("persistSelectionUpdates", () => {
  it("writes each update and never rejects", async () => {
    const updateSelectionUserId = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);
    await expect(
      persistSelectionUpdates({ updateSelectionUserId }, [
        { epochId: 7n, receiptId: "1", userId: "a" },
        { epochId: 7n, receiptId: "2", userId: "b" },
      ])
    ).resolves.toBeUndefined();
    expect(updateSelectionUserId).toHaveBeenCalledTimes(2);
  });
});
