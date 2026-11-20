// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/history-actor-kind`
 * Purpose: Work-item history names each version's actor kind through the one classifier, and a classifier failure never fails the read (task.0133).
 * Scope: `withHistoryActorKinds` with a fake store and classifier. No database.
 * Links: src/bootstrap/history-actor-kind.ts, hub activity-attribution
 * @internal
 */

import type { HistoryActorKind, HistoryEntry } from "@cogni/work-items";
import { readWorkItemHistory } from "@cogni/work-items";
import { describe, expect, it, vi } from "vitest";

import { CLASSIFY_TIMEOUT_MS, withHistoryActorKinds } from "@/bootstrap/history-actor-kind";

const HUMAN = "211a49a5-f35c-4884-8cbf-78fb40a558db";
const NODE_AI = "00000000-0000-4000-a000-0000000a0002";
const OUTSIDE_AI = "52d379aa-e925-4da9-8e6b-2fd62e8a10d0";

function version(n: number, actor: string | null): HistoryEntry {
  return {
    version: String(n),
    commit: `c${n}`.padEnd(32, "0"),
    at: `2026-11-19T00:0${n}:00.000Z`,
    actor,
    reason: `change ${n}`,
    cites: [],
    changed: ["status"],
    diff: {},
  };
}

const VERSIONS = [version(4, NODE_AI), version(3, OUTSIDE_AI), version(2, NODE_AI), version(1, HUMAN), version(0, null)];
const KINDS: Record<string, HistoryActorKind> = { [HUMAN]: "human", [NODE_AI]: "internal", [OUTSIDE_AI]: "external" };

function fakeStore() {
  return {
    get: async () => ({ id: "task.0001" }),
    history: async () => VERSIONS,
    historyPage: async () => ({ entries: VERSIONS, nextCursor: null }),
  };
}

describe("withHistoryActorKinds", () => {
  it("labels every version by its actor's kind, once per distinct actor, on items and refs", async () => {
    const classify = vi.fn(async (userId: string) => KINDS[userId] ?? "unclassified");
    const onLabelled = vi.fn();
    const store = withHistoryActorKinds(fakeStore(), classify, () => {}, onLabelled);

    const full = await readWorkItemHistory(store, "task.0001");
    expect(full.status).toBe(200);
    expect((full.body as { items: HistoryEntry[] }).items.map((v) => v.actorKind)).toEqual([
      "internal",
      "external",
      "internal",
      "human",
      undefined,
    ]);
    expect(classify).toHaveBeenCalledTimes(3);
    expect(full.log.actorKinds).toEqual({ internal: 2, external: 1, human: 1 });
    // A tool or envelope read has no route log, so the store reports every labelled read itself.
    expect(onLabelled).toHaveBeenCalledWith({ versionCount: 5, actorKinds: { internal: 2, external: 1, human: 1 } });

    const refs = await readWorkItemHistory(store, "task.0001", { view: "refs" });
    expect((refs.body as { refs: HistoryEntry[] }).refs.map((v) => v.actorKind)).toEqual([
      "internal",
      "external",
      "internal",
      "human",
      undefined,
    ]);
  });

  it("serves the read without a kind when the classifier fails, and reports each failure", async () => {
    const onFailure = vi.fn();
    const classify = vi.fn(async (userId: string) => {
      if (userId === OUTSIDE_AI) throw new Error("connection ended");
      return KINDS[userId] ?? "unclassified";
    });
    const store = withHistoryActorKinds(fakeStore(), classify, onFailure);

    const full = await readWorkItemHistory(store, "task.0001");
    expect(full.status).toBe(200);
    const items = (full.body as { items: HistoryEntry[] }).items;
    expect(items.map((v) => v.actorKind)).toEqual(["internal", undefined, "internal", "human", undefined]);
    expect(items[1]?.actor).toBe(OUTSIDE_AI);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("serves the read without a kind when the classifier hangs past its deadline", async () => {
    vi.useFakeTimers();
    try {
      const onFailure = vi.fn();
      const hung = new Promise<HistoryActorKind>(() => {});
      const store = withHistoryActorKinds(fakeStore(), () => hung, onFailure);
      const pending = readWorkItemHistory(store, "task.0001");
      await vi.advanceTimersByTimeAsync(CLASSIFY_TIMEOUT_MS);
      const full = await pending;
      expect(full.status).toBe(200);
      expect((full.body as { items: HistoryEntry[] }).items.every((v) => v.actorKind === undefined)).toBe(true);
      expect(onFailure).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes every other store method through unchanged", async () => {
    const base = { ...fakeStore(), list: vi.fn(async () => ({ items: [] })) };
    const store = withHistoryActorKinds(base, async () => "human", () => {});
    await store.list();
    expect(base.list).toHaveBeenCalledTimes(1);
    expect(await store.get()).toEqual({ id: "task.0001" });
  });
});
