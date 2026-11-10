// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/cognition-read`
 * Purpose: The hub inputs of a node's session cognition bundle, read once per store revision and served within a bounded revision check (bug.0018).
 * Scope: Takes a structural port, returns plain data plus `memoHit` and `stale`. Imports no web framework, auth, container, metrics or logger; the route renders and logs.
 * Invariants:
 *   - INDEX_ONLY: domains with counts, the projected governing index, active goals and ONE orientation body. No per-domain scan, no other body.
 *   - ONE_READ_PER_REVISION: per port and orientation ids, one HEAD check and one index read are in flight at a time and shared by every caller; only a complete snapshot (goals readable) is kept, and only if it started after the kept one (monotonic).
 *   - NEVER_OLDER_THAN_LABEL: HEAD is read before the index reads, so a snapshot is never older than its revision label; a new commit changes the key.
 *   - BOUNDED_REVALIDATION: once a complete snapshot exists, a HEAD check slower than `revisionDeadlineMs`, a fresh index read slower than `freshReadDeadlineMs`, a failed check, or a failed or degraded fresh read serves it with `stale: true`; the shared check and read keep running and refresh it when they land. A shared HEAD check is reused for at most `COGNITION_HEAD_SHARE_MS`, so one hung query never captures later callers. A snapshot unconfirmed for `maxStaleMs` is never served stale; callers then wait. With no complete snapshot, callers wait.
 *   - NO_GOAL_PROGRESS: goal KPI readings are not part of cognition; they are read live from the metrics API.
 * Side-effects: IO (port reads through the injected port)
 * Links: bug.0018, packages/knowledge-store/src/domain/graph-read.ts
 * @public
 */

import type { KnowledgeStorePort } from "../port/knowledge-store.port.js";
import { type GoalsSection, resolveGoals } from "./dao-goals.js";

/** The slice of a knowledge-store port the cognition snapshot reads. */
export type CognitionReadPort = Pick<
  KnowledgeStorePort,
  | "currentCommit"
  | "listDomainsFull"
  | "listGoverningIndex"
  | "getKnowledge"
  | "listActiveGoals"
>;

export interface CognitionSnapshot {
  readonly revision: string;
  /** Registered domains that hold at least one entry. */
  readonly domains: ReadonlyArray<{
    domain: string;
    description: string | null;
    entryCount: number;
  }>;
  readonly governingIndex: Awaited<
    ReturnType<CognitionReadPort["listGoverningIndex"]>
  >;
  /** The first of `orientationIds` that exists, in full. */
  readonly orientation: { id: string; content: string } | null;
  readonly goals: GoalsSection;
  /** Wall time of each index read, in ms, so a slow cold read names its cause. */
  readonly readMs: {
    readonly domains: number;
    readonly governing: number;
    readonly orientation: number;
    readonly goals: number;
  };
}

export interface CognitionReadResult {
  readonly snapshot: CognitionSnapshot;
  /** True when no index read was needed: the kept snapshot matched HEAD, or was served stale. */
  readonly memoHit: boolean;
  /** True when HEAD could not be confirmed in time and the kept complete snapshot was served. */
  readonly stale: boolean;
}

export interface CognitionReadOptions {
  /** How long a caller holding a complete snapshot waits for the HEAD check. */
  readonly revisionDeadlineMs?: number;
  /** How long a caller holding a complete snapshot waits for a fresh index read after HEAD moved. */
  readonly freshReadDeadlineMs?: number;
  /** The longest a snapshot may go unconfirmed by HEAD and still be served stale. */
  readonly maxStaleMs?: number;
}

/** Default bound on the HEAD check once a complete snapshot exists. */
export const COGNITION_REVISION_DEADLINE_MS = 250;
/**
 * Default bound on a fresh index read once a complete snapshot exists. After
 * a commit, each Doltgres read takes about 1 s on production; the caller gets
 * the kept snapshot instead and the read lands behind it.
 */
export const COGNITION_FRESH_READ_DEADLINE_MS = 600;
/**
 * Default bound on how long an unconfirmed snapshot may be served stale: the
 * session loader's own refresh TTL (900 s), so a quiet node still answers
 * fast. Most commits are work-item writes that leave cognition unchanged.
 */
export const COGNITION_MAX_STALE_MS = 900_000;
/** A shared HEAD check older than this is not joined; the next caller issues its own. */
export const COGNITION_HEAD_SHARE_MS = 2_000;

interface Kept {
  readonly seq: number;
  readonly snapshot: CognitionSnapshot;
  /** When a HEAD read last matched this snapshot's revision (or its read started). */
  confirmedAt: number;
}

interface CognitionState {
  kept: Kept | null;
  head: Promise<string> | null;
  read: { revision: string; seq: number; promise: Promise<CognitionSnapshot> } | null;
  nextSeq: number;
}

const states = new WeakMap<object, Map<string, CognitionState>>();

function stateFor(port: CognitionReadPort, idsKey: string): CognitionState {
  let byIds = states.get(port);
  if (!byIds) {
    byIds = new Map();
    states.set(port, byIds);
  }
  let state = byIds.get(idsKey);
  if (!state) {
    state = { kept: null, head: null, read: null, nextSeq: 0 };
    byIds.set(idsKey, state);
  }
  return state;
}

async function firstExisting(
  port: CognitionReadPort,
  ids: readonly string[]
): Promise<{ id: string; content: string } | null> {
  for (const id of ids) {
    const entry = await port.getKnowledge(id);
    if (entry) return { id: entry.id, content: entry.content };
  }
  return null;
}

async function snapshotAt(
  port: CognitionReadPort,
  revision: string,
  orientationIds: readonly string[]
): Promise<CognitionSnapshot> {
  const timed = async <T>(read: () => Promise<T>): Promise<[T, number]> => {
    const start = performance.now();
    const value = await read();
    return [value, Math.round(performance.now() - start)];
  };
  const [
    [domains, domainsMs],
    [governingIndex, governingMs],
    [orientation, orientationMs],
    [goals, goalsMs],
  ] = await Promise.all([
    timed(() => port.listDomainsFull()),
    timed(() => port.listGoverningIndex()),
    timed(() => firstExisting(port, orientationIds)),
    timed(() => resolveGoals(port)),
  ]);
  return {
    revision,
    // An empty domain is noise in a precious index.
    domains: domains
      .filter((d) => d.entryCount > 0)
      .map((d) => ({
        domain: d.id,
        description: d.description ?? null,
        entryCount: d.entryCount,
      })),
    governingIndex,
    orientation,
    goals,
    readMs: {
      domains: domainsMs,
      governing: governingMs,
      orientation: orientationMs,
      goals: goalsMs,
    },
  };
}

/** The shared index read for `revision`; keeps its result only if complete and newer than the kept one. */
function readFor(
  state: CognitionState,
  port: CognitionReadPort,
  revision: string,
  orientationIds: readonly string[]
): Promise<CognitionSnapshot> {
  if (state.read?.revision === revision) return state.read.promise;
  const seq = state.nextSeq++;
  const startedAt = Date.now();
  const promise = snapshotAt(port, revision, orientationIds);
  const placed = { revision, seq, promise };
  state.read = placed;
  promise.then(
    (snapshot) => {
      if (state.read === placed) state.read = null;
      if (snapshot.goals.status === "ok" && (!state.kept || seq > state.kept.seq))
        state.kept = { seq, snapshot, confirmedAt: startedAt };
    },
    () => {
      if (state.read === placed) state.read = null;
    }
  );
  return promise;
}

/** The shared HEAD check; when it lands it confirms or refreshes the kept snapshot. */
function headFor(
  state: CognitionState,
  port: CognitionReadPort,
  orientationIds: readonly string[]
): Promise<string> {
  if (state.head) return state.head;
  const askedAt = Date.now();
  const head = port.currentCommit();
  state.head = head;
  const release = setTimeout(() => {
    if (state.head === head) state.head = null;
  }, COGNITION_HEAD_SHARE_MS);
  release.unref?.();
  head.then(
    (revision) => {
      clearTimeout(release);
      if (state.head === head) state.head = null;
      if (state.kept?.snapshot.revision === revision)
        state.kept.confirmedAt = Math.max(state.kept.confirmedAt, askedAt);
      else readFor(state, port, revision, orientationIds).catch(() => undefined);
    },
    () => {
      clearTimeout(release);
      if (state.head === head) state.head = null;
    }
  );
  return head;
}

type Settled<T> = { kind: "value"; value: T } | { kind: "late" | "error" };

/** Settle `promise` within `ms`; a later rejection stays handled. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "late" }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: "value", value });
      },
      () => {
        clearTimeout(timer);
        resolve({ kind: "error" });
      }
    );
  });
}

/**
 * Read the cognition hub inputs at the current store revision. Costs one
 * shared HEAD query when it is unchanged, bounded by `revisionDeadlineMs` once
 * a complete snapshot exists. `orientationIds` are tried in order (exact node
 * entry first, generic seed last).
 */
export async function readCognitionSnapshot(
  port: CognitionReadPort,
  orientationIds: readonly string[],
  {
    revisionDeadlineMs = COGNITION_REVISION_DEADLINE_MS,
    freshReadDeadlineMs = COGNITION_FRESH_READ_DEADLINE_MS,
    maxStaleMs = COGNITION_MAX_STALE_MS,
  }: CognitionReadOptions = {}
): Promise<CognitionReadResult> {
  const state = stateFor(port, orientationIds.join("\u0000"));
  const fallback =
    state.kept && Date.now() - state.kept.confirmedAt <= maxStaleMs
      ? state.kept.snapshot
      : null;
  const head = headFor(state, port, orientationIds);
  if (!fallback) {
    const revision = await head;
    if (state.kept?.snapshot.revision === revision)
      return { snapshot: state.kept.snapshot, memoHit: true, stale: false };
    return {
      snapshot: await readFor(state, port, revision, orientationIds),
      memoHit: false,
      stale: false,
    };
  }
  // The newest complete snapshot at the moment of serving, never an older capture.
  const kept = () => state.kept?.snapshot ?? fallback;
  const checked = await settleWithin(head, revisionDeadlineMs);
  if (checked.kind !== "value")
    return { snapshot: kept(), memoHit: true, stale: true };
  if (checked.value === kept().revision)
    return { snapshot: kept(), memoHit: true, stale: false };
  const fresh = await settleWithin(
    readFor(state, port, checked.value, orientationIds),
    freshReadDeadlineMs
  );
  if (fresh.kind === "value" && fresh.value.goals.status === "ok")
    return { snapshot: fresh.value, memoHit: false, stale: false };
  return { snapshot: kept(), memoHit: true, stale: true };
}
