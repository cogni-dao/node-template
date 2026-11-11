// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/cognition-read`
 * Purpose: The hub inputs of a node's session cognition bundle, read once per store revision and answered within declared time budgets, plus the bundle's revalidation and timing headers (bug.0018).
 * Scope: Takes a structural port, returns plain data plus `memoHit`, `stale` and `staleReason`; exports the ETag, 304 and Server-Timing rules so every node applies them the same way. Imports no web framework, auth, container, metrics or logger; the route renders and logs.
 * Invariants:
 *   - INDEX_ONLY: domains with counts, the projected governing index, active goals and ONE orientation body. No per-domain scan, no other body.
 *   - ONE_HEAD_CHECK: per port and orientation ids, one HEAD query is shared by every caller; one that hangs past `COGNITION_HEAD_ABANDON_MS` is abandoned. A HEAD result older than one already landed is ignored.
 *   - READS_IN_HEAD_ORDER: only an in-order HEAD result starts an index read, shared by every caller; callers never start reads, so a late older HEAD cannot regress the kept snapshot. A snapshot is kept only if complete (goals readable) and started after the kept one. A read that hangs past the abandon window is abandoned.
 *   - BOUNDED_INFLIGHT: at most `COGNITION_MAX_UNSETTLED` HEAD checks and as many reads are unsettled per port; beyond it callers get the kept snapshot or a 503, never a new query.
 *   - NEVER_OLDER_THAN_LABEL: HEAD is read before the index reads, so a snapshot is never older than its revision label; a new commit changes the key.
 *   - BOUNDED_REVALIDATION: once a complete snapshot exists, a HEAD check slower than `revisionDeadlineMs`, a fresh read slower than `freshReadDeadlineMs`, or a failed or degraded check/read serves it with `stale: true` and a `staleReason`; the shared check and read keep running and refresh it. A snapshot unconfirmed for `maxStaleMs` is never served stale.
 *   - BOUNDED_COLD: a caller with nothing to serve waits at most `coldDeadlineMs`, then gets `CognitionUnavailableError` (the route answers a retryable 503).
 *   - NEVER_CONFIRM_STALE: `cognitionEtag` is null for a stale, degraded or hubless bundle, so a 304 only ever confirms a HEAD-confirmed complete bundle.
 *   - NO_GOAL_PROGRESS: goal KPI readings are not part of cognition; they are read live from the metrics API.
 * Side-effects: IO (port reads through the injected port)
 * Links: bug.0018, packages/knowledge-store/src/domain/graph-read.ts
 * @public
 */

import { createHash } from "node:crypto";

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

/** Why a kept snapshot was served instead of a confirmed one. */
export type CognitionStaleReason =
  | "head_slow"
  | "head_failed"
  | "read_slow"
  | "read_failed"
  | "read_degraded";

export interface CognitionReadResult {
  readonly snapshot: CognitionSnapshot;
  /** True when no index read was needed: the kept snapshot matched HEAD, or was served stale. */
  readonly memoHit: boolean;
  /** True when HEAD could not be confirmed in time and the kept complete snapshot was served. */
  readonly stale: boolean;
  readonly staleReason?: CognitionStaleReason;
}

export interface CognitionReadOptions {
  /** How long a caller holding a complete snapshot waits for the HEAD check. */
  readonly revisionDeadlineMs?: number;
  /** How long a caller holding a complete snapshot waits for a fresh read after HEAD moved. */
  readonly freshReadDeadlineMs?: number;
  /** The longest a snapshot may go unconfirmed by HEAD and still be served stale. */
  readonly maxStaleMs?: number;
  /** How long a caller with nothing to serve waits before `CognitionUnavailableError`. */
  readonly coldDeadlineMs?: number;
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
 * session loader's own refresh TTL (900 s). Most commits are work-item writes
 * that leave cognition unchanged.
 */
export const COGNITION_MAX_STALE_MS = 900_000;
/** Default bound on a caller with nothing to serve; under the session loader's 6 s fetch timeout. */
export const COGNITION_COLD_DEADLINE_MS = 5_000;
/** A HEAD check or index read still running after this is abandoned, and the next caller asks again. */
export const COGNITION_HEAD_ABANDON_MS = 30_000;
/**
 * At most this many HEAD checks, and this many index reads, may be unsettled
 * (running or abandoned) per port. Beyond it nothing new is issued: callers
 * get the kept snapshot or a 503. This bounds how many queries cognition
 * adds while the store hangs; it does not protect the pool. One read issues
 * about five queries on a five-connection pool, and the read client has no
 * statement timeout, so a truly hung query holds its connection until the
 * pod restarts.
 */
export const COGNITION_MAX_UNSETTLED = 2;
/** Browsers and agents revalidate every use; never shared by intermediaries. */
export const COGNITION_CACHE_CONTROL = "private, no-cache, must-revalidate";

/** No complete snapshot could be read within `coldDeadlineMs`; retryable. */
export class CognitionUnavailableError extends Error {
  constructor(readonly reason: "cold_timeout" | "cold_failed") {
    super(`cognition unavailable: ${reason}`);
    this.name = "CognitionUnavailableError";
  }
}

interface Kept {
  readonly seq: number;
  readonly snapshot: CognitionSnapshot;
  /** When a HEAD read last matched this snapshot's revision (or its read started). */
  confirmedAt: number;
}

interface CognitionState {
  kept: Kept | null;
  head: Promise<string> | null;
  unsettledHeads: number;
  unsettledReads: number;
  /** Ask order of the last HEAD result applied; an older one landing later is ignored. */
  headLanded: number;
  nextHeadSeq: number;
  read: { revision: string; promise: Promise<CognitionSnapshot> } | null;
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
    state = {
      kept: null,
      head: null,
      unsettledHeads: 0,
      unsettledReads: 0,
      headLanded: -1,
      nextHeadSeq: 0,
      read: null,
      nextSeq: 0,
    };
    byIds.set(idsKey, state);
  }
  return state;
}

/**
 * `Promise.all`, but it settles only after every query settles, so the
 * unsettled-read count tracks real queries; it rejects with the first failure.
 */
async function settledAll<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }]
): Promise<T> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** The first id that exists; the lookups run in parallel on the pooled read client. */
async function firstExisting(
  port: CognitionReadPort,
  ids: readonly string[]
): Promise<{ id: string; content: string } | null> {
  const entries = await settledAll(ids.map((id) => port.getKnowledge(id)));
  const entry = entries.find((e) => e != null);
  return entry ? { id: entry.id, content: entry.content } : null;
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
  ] = await settledAll([
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

/**
 * The shared index read for `revision`. Only `headFor` starts one, for an
 * in-order HEAD result, so reads start in revision order. A result is kept
 * only if complete and started after the kept one. A read still running after
 * `COGNITION_HEAD_ABANDON_MS` is abandoned; at most `COGNITION_MAX_UNSETTLED`
 * may be unsettled.
 */
function readFor(
  state: CognitionState,
  port: CognitionReadPort,
  revision: string,
  orientationIds: readonly string[]
): void {
  if (state.read?.revision === revision) return;
  if (state.unsettledReads >= COGNITION_MAX_UNSETTLED) return;
  const seq = state.nextSeq++;
  const startedAt = Date.now();
  const promise = snapshotAt(port, revision, orientationIds);
  const placed = { revision, promise };
  state.read = placed;
  state.unsettledReads++;
  const abandon = setTimeout(() => {
    if (state.read === placed) state.read = null;
  }, COGNITION_HEAD_ABANDON_MS);
  abandon.unref?.();
  const settle = () => {
    clearTimeout(abandon);
    state.unsettledReads--;
    if (state.read === placed) state.read = null;
  };
  promise.then(
    (snapshot) => {
      settle();
      if (snapshot.goals.status === "ok" && (!state.kept || seq > state.kept.seq))
        state.kept = { seq, snapshot, confirmedAt: startedAt };
    },
    settle
  );
}

/**
 * The shared HEAD check. Callers join it while it runs. It is abandoned only
 * after `COGNITION_HEAD_ABANDON_MS`, and at most `COGNITION_MAX_UNSETTLED` may
 * be unsettled. A result that lands after a newer one is ignored. A result
 * that lands in order confirms the kept snapshot or starts the read for the
 * new revision. Callers never start reads themselves, so a late older HEAD
 * cannot start one.
 */
function headFor(
  state: CognitionState,
  port: CognitionReadPort,
  orientationIds: readonly string[]
): Promise<string> {
  if (state.head) return state.head;
  if (state.unsettledHeads >= COGNITION_MAX_UNSETTLED)
    return Promise.reject(new Error("cognition HEAD capacity"));
  const seq = state.nextHeadSeq++;
  const askedAt = Date.now();
  const head = port.currentCommit();
  state.head = head;
  state.unsettledHeads++;
  const abandon = setTimeout(() => {
    if (state.head === head) state.head = null;
  }, COGNITION_HEAD_ABANDON_MS);
  abandon.unref?.();
  const settle = () => {
    clearTimeout(abandon);
    state.unsettledHeads--;
    if (state.head === head) state.head = null;
  };
  head.then(
    (revision) => {
      settle();
      if (seq < state.headLanded) return;
      state.headLanded = seq;
      if (state.kept?.snapshot.revision === revision)
        state.kept.confirmedAt = Math.max(state.kept.confirmedAt, askedAt);
      else readFor(state, port, revision, orientationIds);
    },
    settle
  );
  return head;
}

/**
 * What a caller gets once its HEAD result landed: the kept snapshot if it
 * matches, else the read `headFor` started for the newest landed HEAD (this
 * revision or a newer one), else null.
 */
function afterHead(
  state: CognitionState,
  revision: string
): { memo: CognitionSnapshot } | { read: Promise<CognitionSnapshot> } | null {
  if (state.kept?.snapshot.revision === revision) return { memo: state.kept.snapshot };
  if (state.read) return { read: state.read.promise };
  return null;
}

type Settled<T> =
  | { kind: "value"; value: T }
  | { kind: "late" }
  | { kind: "error" };

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

async function readCold(
  state: CognitionState,
  head: Promise<string>
): Promise<CognitionReadResult> {
  const next = afterHead(state, await head);
  if (!next) throw new CognitionUnavailableError("cold_failed");
  if ("memo" in next) return { snapshot: next.memo, memoHit: true, stale: false };
  return { snapshot: await next.read, memoHit: false, stale: false };
}

/**
 * Read the cognition hub inputs at the current store revision. Costs one
 * shared HEAD query when it is unchanged, bounded by `revisionDeadlineMs` once
 * a complete snapshot exists, and by `coldDeadlineMs` before one does.
 * `orientationIds` are tried in order (exact node entry first, generic seed
 * last). Throws `CognitionUnavailableError` only when nothing can be served.
 */
export async function readCognitionSnapshot(
  port: CognitionReadPort,
  orientationIds: readonly string[],
  {
    revisionDeadlineMs = COGNITION_REVISION_DEADLINE_MS,
    freshReadDeadlineMs = COGNITION_FRESH_READ_DEADLINE_MS,
    maxStaleMs = COGNITION_MAX_STALE_MS,
    coldDeadlineMs = COGNITION_COLD_DEADLINE_MS,
  }: CognitionReadOptions = {}
): Promise<CognitionReadResult> {
  const state = stateFor(port, orientationIds.join("\u0000"));
  const fallback =
    state.kept && Date.now() - state.kept.confirmedAt <= maxStaleMs
      ? state.kept.snapshot
      : null;
  const head = headFor(state, port, orientationIds);
  if (!fallback) {
    const cold = await settleWithin(
      readCold(state, head),
      coldDeadlineMs
    );
    if (cold.kind === "value") return cold.value;
    throw new CognitionUnavailableError(
      cold.kind === "late" ? "cold_timeout" : "cold_failed"
    );
  }
  // The newest complete snapshot at the moment of serving, never an older capture.
  const kept = () => state.kept?.snapshot ?? fallback;
  const stale = (staleReason: CognitionStaleReason): CognitionReadResult => ({
    snapshot: kept(),
    memoHit: true,
    stale: true,
    staleReason,
  });
  const checked = await settleWithin(head, revisionDeadlineMs);
  if (checked.kind === "late") return stale("head_slow");
  if (checked.kind === "error") return stale("head_failed");
  const next = afterHead(state, checked.value);
  if (!next) return stale("read_failed");
  if ("memo" in next) return { snapshot: next.memo, memoHit: true, stale: false };
  const fresh = await settleWithin(next.read, freshReadDeadlineMs);
  if (fresh.kind === "late") return stale("read_slow");
  if (fresh.kind === "error") return stale("read_failed");
  if (fresh.value.goals.status !== "ok") return stale("read_degraded");
  // The read was kept on landing unless a newer one already was; serve the newest.
  return { snapshot: kept(), memoHit: false, stale: false };
}

/**
 * The bundle's weak ETag, or null when it must not be revalidated: no hub, a
 * stale snapshot, or unreadable goals. `parts` are everything else the body
 * depends on (build, origin, node name, mission).
 */
export function cognitionEtag(
  result: CognitionReadResult | null,
  parts: readonly string[]
): string | null {
  if (!result || result.stale || result.snapshot.goals.status !== "ok")
    return null;
  const digest = createHash("sha256")
    .update([result.snapshot.revision, ...parts].join("\u0000"))
    .digest("base64url")
    .slice(0, 27);
  return `W/"${digest}"`;
}

/** True when an If-None-Match header names this entity tag (weak compare) or `*`. */
export function cognitionEtagMatches(
  ifNoneMatch: string | null | undefined,
  etag: string | null
): boolean {
  if (!ifNoneMatch || !etag) return false;
  const bare = etag.replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === bare || tag === "*");
}

/** W3C Server-Timing for the bundle: the hub read (none, memo, read, stale) and the whole route. */
export function cognitionServerTiming(
  result: CognitionReadResult | null,
  hubMs: number,
  totalMs: number
): string {
  const desc = !result
    ? "none"
    : result.stale
      ? `stale ${result.staleReason ?? ""}`.trim()
      : result.memoHit
        ? "memo"
        : "read";
  return `hub;dur=${hubMs.toFixed(1)};desc="${desc}", total;dur=${totalMs.toFixed(1)}`;
}
