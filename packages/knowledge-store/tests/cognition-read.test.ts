// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/cognition-read`
 * Purpose: Pins the cognition snapshot: index-only reads, one read per store revision shared by concurrent callers, a commit busting the memo, orientation precedence, and failed or goal-degraded reads never remembered (bug.0018).
 * Scope: `readCognitionSnapshot` over a mocked port. No database.
 * Side-effects: none
 * Links: bug.0018, ../src/domain/cognition-read.ts
 */

import { describe, expect, it, vi } from "vitest";

import {
  type CognitionReadPort,
  readCognitionSnapshot,
} from "../src/domain/cognition-read.js";

const ORIENTATION_IDS = ["fresh-agent-orientation", "cogni-agent-orientation"];

function fixture(bodies: Record<string, string> = {
  "fresh-agent-orientation": "the map",
  "cogni-agent-orientation": "starter",
}) {
  let revision = "rev-a";
  const calls = {
    domains: vi.fn(async () => [
      { id: "meta", name: "Meta", description: "How to use", confidencePct: 50, createdAt: new Date(0), entryCount: 2 },
      { id: "empty", name: "Empty", description: null, confidencePct: 50, createdAt: new Date(0), entryCount: 0 },
    ]),
    governing: vi.fn(async () => [
      { id: "g-1", domain: "meta", entryType: "guide", useWhen: "always" },
    ]),
    body: vi.fn(async (id: string) =>
      id in bodies ? { id, content: bodies[id] } : null
    ),
    goals: vi.fn(async () => [
      { id: "goal-a", title: "A", content: "goal body", evaluateAt: null },
    ]),
  };
  const port = {
    currentCommit: async () => revision,
    listDomainsFull: calls.domains,
    listGoverningIndex: calls.governing,
    getKnowledge: calls.body,
    listActiveGoals: calls.goals,
  } as unknown as CognitionReadPort;
  return { port, calls, commit: (next: string) => { revision = next; } };
}

describe("readCognitionSnapshot", () => {
  it("reads the index, one orientation body and goals; drops empty domains", async () => {
    const { port, calls } = fixture();
    const { snapshot, memoHit } = await readCognitionSnapshot(port, ORIENTATION_IDS);
    expect(memoHit).toBe(false);
    expect(snapshot.revision).toBe("rev-a");
    expect(snapshot.domains).toEqual([
      { domain: "meta", description: "How to use", entryCount: 2 },
    ]);
    expect(snapshot.governingIndex.map((r) => r.id)).toEqual(["g-1"]);
    expect(snapshot.orientation).toEqual({ id: "fresh-agent-orientation", content: "the map" });
    expect(snapshot.goals.status).toBe("ok");
    // Exactly one body read: the orientation. No scan, no other body.
    expect(calls.body).toHaveBeenCalledTimes(1);
  });

  it("serves the same revision from one shared read and re-reads after a commit", async () => {
    const { port, calls, commit } = fixture();
    const [a, b] = await Promise.all([
      readCognitionSnapshot(port, ORIENTATION_IDS),
      readCognitionSnapshot(port, ORIENTATION_IDS),
    ]);
    expect([a.memoHit, b.memoHit]).toEqual([false, true]);
    expect((await readCognitionSnapshot(port, ORIENTATION_IDS)).memoHit).toBe(true);
    expect(calls.governing).toHaveBeenCalledTimes(1);

    commit("rev-b");
    const next = await readCognitionSnapshot(port, ORIENTATION_IDS);
    expect(next.memoHit).toBe(false);
    expect(next.snapshot.revision).toBe("rev-b");
    expect(calls.governing).toHaveBeenCalledTimes(2);
  });

  it("falls back to the generic seed, else null", async () => {
    const seeded = await readCognitionSnapshot(
      fixture({ "cogni-agent-orientation": "starter" }).port,
      ORIENTATION_IDS
    );
    expect(seeded.snapshot.orientation?.id).toBe("cogni-agent-orientation");
    const empty = await readCognitionSnapshot(fixture({}).port, ORIENTATION_IDS);
    expect(empty.snapshot.orientation).toBeNull();
  });

  it("forgets a failed read", async () => {
    const { port, calls } = fixture();
    calls.governing.mockRejectedValueOnce(new Error("busy"));
    await expect(readCognitionSnapshot(port, ORIENTATION_IDS)).rejects.toThrow("busy");
    const retry = await readCognitionSnapshot(port, ORIENTATION_IDS);
    expect(retry.memoHit).toBe(false);
    expect(retry.snapshot.governingIndex).toHaveLength(1);
  });

  it("serves an unreadable goals section visibly but never remembers it", async () => {
    const { port, calls } = fixture();
    calls.goals.mockRejectedValueOnce(new Error("goals down"));
    const degraded = await readCognitionSnapshot(port, ORIENTATION_IDS);
    expect(degraded.snapshot.goals.status).toBe("unavailable");
    const healed = await readCognitionSnapshot(port, ORIENTATION_IDS);
    expect(healed.memoHit).toBe(false);
    expect(healed.snapshot.goals.status).toBe("ok");
  });
});
