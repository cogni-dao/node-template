// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/cognition-read`
 * Purpose: Pins the cognition snapshot: index-only reads, one read per revision shared by concurrent callers, a commit busting the memo, orientation precedence, failed or goal-degraded reads never remembered, and bounded revalidation that serves the last complete snapshot (bug.0018).
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    // Concurrent callers share one HEAD check and one index read.
    expect([a.memoHit, b.memoHit]).toEqual([false, false]);
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

  it("serves the last complete snapshot when the revision check is slow, then refreshes behind it", async () => {
    const { port, calls } = fixture();
    let next: Promise<string> = Promise.resolve("k1");
    const keyed = Object.assign(port, { currentCommit: () => next });
    await readCognitionSnapshot(keyed, ORIENTATION_IDS);

    const late = deferred<string>();
    next = late.promise;
    const served = await readCognitionSnapshot(keyed, ORIENTATION_IDS, { revisionDeadlineMs: 5 });
    expect(served).toMatchObject({ stale: true, memoHit: true });
    expect(served.snapshot.revision).toBe("k1");

    late.resolve("k2");
    await vi.waitFor(() => expect(calls.governing).toHaveBeenCalledTimes(2));
    next = Promise.resolve("k2");
    await vi.waitFor(async () =>
      expect(
        (await readCognitionSnapshot(keyed, ORIENTATION_IDS)).snapshot.revision
      ).toBe("k2")
    );
    const fresh = await readCognitionSnapshot(keyed, ORIENTATION_IDS);
    expect(fresh).toMatchObject({ stale: false, memoHit: true });
    expect(calls.governing).toHaveBeenCalledTimes(2);
  });

  it("serves the last complete snapshot when the revision check or the fresh read fails", async () => {
    const { port, calls } = fixture();
    let next: () => Promise<string> = async () => "k1";
    const keyed = Object.assign(port, { currentCommit: () => next() });
    await readCognitionSnapshot(keyed, ORIENTATION_IDS);

    next = async () => {
      throw new Error("dolt busy");
    };
    expect(await readCognitionSnapshot(keyed, ORIENTATION_IDS)).toMatchObject({ stale: true });

    next = async () => "k2";
    calls.governing.mockRejectedValueOnce(new Error("read timeout"));
    const served = await readCognitionSnapshot(keyed, ORIENTATION_IDS);
    expect(served).toMatchObject({ stale: true });
    expect(served.snapshot.revision).toBe("k1");
  });

  it("never serves stale while HEAD answers in time", async () => {
    const { port, commit } = fixture();
    await readCognitionSnapshot(port, ORIENTATION_IDS);
    for (const rev of ["rev-a", "rev-b", "rev-b", "rev-c"]) {
      commit(rev);
      const r = await readCognitionSnapshot(port, ORIENTATION_IDS);
      expect(r).toMatchObject({ stale: false });
      expect(r.snapshot.revision).toBe(rev);
    }
  });

  it("shares one in-flight HEAD check across concurrent callers", async () => {
    const { port } = fixture();
    await readCognitionSnapshot(port, ORIENTATION_IDS);
    const late = deferred<string>();
    const head = vi.fn(() => late.promise);
    const keyed = Object.assign(port, { currentCommit: head });
    const served = await Promise.all(
      Array.from({ length: 5 }, () =>
        readCognitionSnapshot(keyed, ORIENTATION_IDS, { revisionDeadlineMs: 5 })
      )
    );
    expect(served.every((r) => r.stale)).toBe(true);
    expect(head).toHaveBeenCalledTimes(1);
    late.resolve("rev-a");
  });

  it("never lets an older read that lands late replace a newer kept snapshot", async () => {
    const { port, calls } = fixture();
    let rev = "k1";
    const keyed = Object.assign(port, { currentCommit: async () => rev });
    await readCognitionSnapshot(keyed, ORIENTATION_IDS);
    const slow = deferred<{ id: string; domain: string; entryType: string; useWhen: string }[]>();
    calls.governing.mockImplementationOnce(() => slow.promise);
    rev = "k2";
    const older = readCognitionSnapshot(keyed, ORIENTATION_IDS);
    await new Promise((r) => setTimeout(r, 0));
    rev = "k3";
    expect((await readCognitionSnapshot(keyed, ORIENTATION_IDS)).snapshot.revision).toBe("k3");
    slow.resolve([]);
    expect((await older).snapshot.revision).toBe("k2");
    // k2 started first, so it never replaces k3 as the stale fallback.
    const bad = Object.assign(keyed, {
      currentCommit: async () => {
        throw new Error("dolt busy");
      },
    });
    expect((await readCognitionSnapshot(bad, ORIENTATION_IDS)).snapshot.revision).toBe("k3");
  });

  it("serves the kept snapshot stale when a fresh read comes back with goals unreadable", async () => {
    const { port, calls, commit } = fixture();
    await readCognitionSnapshot(port, ORIENTATION_IDS);
    commit("rev-b");
    calls.goals.mockRejectedValueOnce(new Error("goals down"));
    const served = await readCognitionSnapshot(port, ORIENTATION_IDS);
    expect(served).toMatchObject({ stale: true });
    expect(served.snapshot.revision).toBe("rev-a");
    expect(served.snapshot.goals.status).toBe("ok");
  });

  it("stops serving stale once the kept snapshot is unconfirmed past maxStaleMs", async () => {
    const { port } = fixture();
    let next: () => Promise<string> = async () => "k1";
    const keyed = Object.assign(port, { currentCommit: () => next() });
    await readCognitionSnapshot(keyed, ORIENTATION_IDS);
    next = async () => {
      throw new Error("dolt down");
    };
    await expect(
      readCognitionSnapshot(keyed, ORIENTATION_IDS, { maxStaleMs: -1 })
    ).rejects.toThrow("dolt down");
  });

  it("bounds a fresh read after a commit: serves the kept snapshot stale, then keeps the fresh one", async () => {
    const { port, calls, commit } = fixture();
    await readCognitionSnapshot(port, ORIENTATION_IDS);
    const slow = deferred<{ id: string; domain: string; entryType: string; useWhen: string }[]>();
    calls.governing.mockImplementationOnce(() => slow.promise);
    commit("rev-b");
    const served = await readCognitionSnapshot(port, ORIENTATION_IDS, { freshReadDeadlineMs: 5 });
    expect(served).toMatchObject({ stale: true });
    expect(served.snapshot.revision).toBe("rev-a");
    slow.resolve([]);
    await vi.waitFor(async () => {
      const next = await readCognitionSnapshot(port, ORIENTATION_IDS);
      expect(next).toMatchObject({ stale: false, memoHit: true });
      expect(next.snapshot.revision).toBe("rev-b");
    });
    expect(calls.governing).toHaveBeenCalledTimes(2);
  });

  it("makes a first caller wait: there is nothing complete to serve yet", async () => {
    const { port } = fixture();
    const late = deferred<string>();
    const keyed = Object.assign(port, { currentCommit: () => late.promise });
    const pending = readCognitionSnapshot(keyed, ORIENTATION_IDS, { revisionDeadlineMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    late.resolve("k1");
    expect(await pending).toMatchObject({ stale: false, memoHit: false });
  });
});
