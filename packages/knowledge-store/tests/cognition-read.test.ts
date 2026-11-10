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
  type CognitionReadResult,
  COGNITION_HEAD_ABANDON_MS,
  CognitionUnavailableError,
  cognitionEtag,
  cognitionEtagMatches,
  cognitionServerTiming,
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
  it("reads the index, the orientation candidates in parallel and goals; drops empty domains", async () => {
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
    // Body reads are only the orientation candidates, looked up in parallel. No scan, no other body.
    expect(calls.body.mock.calls.map(([id]) => id)).toEqual(ORIENTATION_IDS);
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
    await expect(readCognitionSnapshot(port, ORIENTATION_IDS)).rejects.toThrow(
      CognitionUnavailableError
    );
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
    // The caller that waited on the older read is served the newest kept snapshot.
    expect((await older).snapshot.revision).toBe("k3");
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
    ).rejects.toThrow(CognitionUnavailableError);
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

  it("serves stale within maxStaleMs and names the reason", async () => {
    const { port, calls } = fixture();
    let next: () => Promise<string> = async () => "rev-a";
    const keyed = Object.assign(port, { currentCommit: () => next() });
    await readCognitionSnapshot(keyed, ORIENTATION_IDS);
    next = async () => {
      throw new Error("dolt busy");
    };
    expect(
      await readCognitionSnapshot(keyed, ORIENTATION_IDS, { maxStaleMs: 60_000 })
    ).toMatchObject({ stale: true, staleReason: "head_failed" });
    next = async () => "rev-b";
    calls.governing.mockRejectedValueOnce(new Error("read timeout"));
    expect(await readCognitionSnapshot(keyed, ORIENTATION_IDS)).toMatchObject({
      stale: true,
      staleReason: "read_failed",
    });
  });

  it("bounds a cold caller: nothing to serve and a hung HEAD gives CognitionUnavailableError", async () => {
    const { port } = fixture();
    const hung = deferred<string>();
    const keyed = Object.assign(port, { currentCommit: () => hung.promise });
    const error = await readCognitionSnapshot(keyed, ORIENTATION_IDS, {
      coldDeadlineMs: 5,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CognitionUnavailableError);
    expect((error as CognitionUnavailableError).reason).toBe("cold_timeout");
    hung.resolve("rev-a");
  });
});

describe("readCognitionSnapshot under a hung store", () => {
  it("abandons a hung HEAD, ignores it when it lands late, and never regresses the kept snapshot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { port, calls } = fixture();
      const heads: Array<ReturnType<typeof deferred<string>>> = [];
      const keyed = Object.assign(port, {
        currentCommit: vi.fn(() => {
          const d = deferred<string>();
          heads.push(d);
          return d.promise;
        }),
      });
      // First caller: HEAD 0 hangs; the cold caller gives up at its deadline.
      const first = readCognitionSnapshot(keyed, ORIENTATION_IDS, { coldDeadlineMs: 100 }).catch(
        (e: unknown) => e
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(await first).toBeInstanceOf(CognitionUnavailableError);
      // Still within the abandon window: a new caller joins HEAD 0, no new query.
      void readCognitionSnapshot(keyed, ORIENTATION_IDS, { coldDeadlineMs: 50 }).catch(() => undefined);
      expect(keyed.currentCommit).toHaveBeenCalledTimes(1);
      // Past the window: HEAD 0 is abandoned and HEAD 1 is asked.
      await vi.advanceTimersByTimeAsync(COGNITION_HEAD_ABANDON_MS);
      const second = readCognitionSnapshot(keyed, ORIENTATION_IDS, { coldDeadlineMs: 1_000 });
      expect(keyed.currentCommit).toHaveBeenCalledTimes(2);
      heads[1]?.resolve("rev-new");
      expect((await second).snapshot.revision).toBe("rev-new");
      // HEAD 0 lands late with an older revision: ignored, no read for it.
      heads[0]?.resolve("rev-old");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.governing).toHaveBeenCalledTimes(1);
      const third = readCognitionSnapshot(keyed, ORIENTATION_IDS);
      heads[2]?.resolve("rev-new");
      expect(await third).toMatchObject({ memoHit: true, stale: false });
      expect((await third).snapshot.revision).toBe("rev-new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps unsettled HEAD checks: past the cap a cold caller gets 503 without a new query", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { port } = fixture();
      const keyed = Object.assign(port, {
        currentCommit: vi.fn(() => new Promise<string>(() => undefined)),
      });
      for (let i = 0; i < 2; i++) {
        void readCognitionSnapshot(keyed, ORIENTATION_IDS, { coldDeadlineMs: 10 }).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(COGNITION_HEAD_ABANDON_MS + 1);
      }
      expect(keyed.currentCommit).toHaveBeenCalledTimes(2);
      const capped = await readCognitionSnapshot(keyed, ORIENTATION_IDS, { coldDeadlineMs: 10 }).catch(
        (e: unknown) => e
      );
      expect(capped).toBeInstanceOf(CognitionUnavailableError);
      expect(keyed.currentCommit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readCognitionSnapshot read-side guards", () => {
  async function harness(revisionOf: () => string) {
    const { port, calls } = fixture();
    const keyed = Object.assign(port, { currentCommit: async () => revisionOf() });
    // Every read: domains fails at once, governing hangs forever.
    calls.domains.mockImplementation(async () => {
      throw new Error("domains failed");
    });
    calls.governing.mockImplementation(() => new Promise(() => undefined));
    const cold = async () => {
      const pending = readCognitionSnapshot(keyed, ORIENTATION_IDS, {
        coldDeadlineMs: 10,
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);
      return pending;
    };
    return { calls, cold };
  }

  it("counts a read until every query settles, so a fast failure beside a hang still holds the cap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let rev = 0;
      const { calls, cold } = await harness(() => `rev-${rev++}`);
      // Reads 1 and 2 (new revisions) start; each fails fast but stays unsettled.
      expect(await cold()).toBeInstanceOf(CognitionUnavailableError);
      expect(await cold()).toBeInstanceOf(CognitionUnavailableError);
      expect(calls.governing).toHaveBeenCalledTimes(2);
      // The cap: a third revision starts no read, even after the abandon window.
      expect(await cold()).toBeInstanceOf(CognitionUnavailableError);
      await vi.advanceTimersByTimeAsync(COGNITION_HEAD_ABANDON_MS);
      expect(await cold()).toBeInstanceOf(CognitionUnavailableError);
      expect(calls.governing).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons a hung read for the same revision after the window, then reads again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { calls, cold } = await harness(() => "rev-same");
      expect(await cold()).toBeInstanceOf(CognitionUnavailableError);
      expect(calls.governing).toHaveBeenCalledTimes(1);
      // Within the window the same revision joins the hung read.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await cold()).toBeInstanceOf(CognitionUnavailableError);
      expect(calls.governing).toHaveBeenCalledTimes(1);
      // Past the window it is abandoned and a new read starts.
      await vi.advanceTimersByTimeAsync(COGNITION_HEAD_ABANDON_MS);
      expect(await cold()).toBeInstanceOf(CognitionUnavailableError);
      expect(calls.governing).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cognition headers", () => {
  const result = (over: Partial<CognitionReadResult> = {}): CognitionReadResult => ({
    snapshot: {
      revision: "rev-a",
      domains: [],
      governingIndex: [],
      orientation: null,
      goals: { status: "ok", goals: [] },
      readMs: { domains: 1, governing: 1, orientation: 1, goals: 1 },
    },
    memoHit: true,
    stale: false,
    ...over,
  });

  it("never gives a stale, degraded or hubless bundle an ETag", () => {
    expect(cognitionEtag(result(), ["build", "origin"])).toMatch(/^W\/"[\w-]{27}"$/);
    expect(cognitionEtag(result({ stale: true, staleReason: "head_slow" }), [])).toBeNull();
    expect(
      cognitionEtag(
        result({
          snapshot: { ...result().snapshot, goals: { status: "unavailable", reason: "x" } },
        }),
        []
      )
    ).toBeNull();
    expect(cognitionEtag(null, [])).toBeNull();
  });

  it("changes the ETag with the revision or any part", () => {
    const base = cognitionEtag(result(), ["b1", "o1"]);
    expect(cognitionEtag(result(), ["b2", "o1"])).not.toBe(base);
    expect(
      cognitionEtag(result({ snapshot: { ...result().snapshot, revision: "rev-b" } }), ["b1", "o1"])
    ).not.toBe(base);
  });

  it("matches If-None-Match weakly, in lists and by *; never against a null ETag", () => {
    const etag = cognitionEtag(result(), ["b"]);
    expect(cognitionEtagMatches(etag, etag)).toBe(true);
    expect(cognitionEtagMatches(`"x", ${etag?.slice(2)}`, etag)).toBe(true);
    expect(cognitionEtagMatches("*", etag)).toBe(true);
    expect(cognitionEtagMatches("*", null)).toBe(false);
    expect(cognitionEtagMatches(null, etag)).toBe(false);
  });

  it("describes the hub read in Server-Timing", () => {
    expect(cognitionServerTiming(result(), 1.234, 5)).toBe(
      'hub;dur=1.2;desc="memo", total;dur=5.0'
    );
    expect(cognitionServerTiming(result({ memoHit: false }), 1, 2)).toContain('desc="read"');
    expect(
      cognitionServerTiming(result({ stale: true, staleReason: "read_slow" }), 1, 2)
    ).toContain('desc="stale read_slow"');
    expect(cognitionServerTiming(null, 0, 2)).toContain('desc="none"');
  });
});
