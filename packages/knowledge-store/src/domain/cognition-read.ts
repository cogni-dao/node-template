// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/cognition-read`
 * Purpose: The hub inputs of a node's session cognition bundle, read once per store revision and served within a bounded revision check (bug.0018).
 * Scope: Takes a structural port, returns plain data plus `memoHit` and `stale`. Imports no web framework, auth, container, metrics or logger; the route renders and logs.
 * Invariants:
 *   - INDEX_ONLY: domains with counts, the projected governing index, active goals and ONE orientation body. No per-domain scan, no other body.
 *   - ONE_READ_PER_REVISION: per port, the latest revision's snapshot is remembered; concurrent callers share one in-flight read; a failed read or an unreadable goals section is forgotten.
 *   - NEVER_OLDER_THAN_LABEL: the key is the store HEAD, read before the index reads, so a snapshot is never older than its revision label; a new commit changes the key.
 *   - BOUNDED_REVALIDATION: with a complete snapshot already in memory, a revision check slower than `revisionDeadlineMs`, a failed check, or a failed fresh read serves that snapshot with `stale: true`; a late revision then refreshes the memo behind the response. With no complete snapshot, callers wait.
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
}

export interface CognitionReadResult {
  readonly snapshot: CognitionSnapshot;
  /** True when the snapshot came from the per-revision memo or a shared in-flight read. */
  readonly memoHit: boolean;
  /** True when the revision could not be confirmed in time and the last complete snapshot was served. */
  readonly stale: boolean;
}

export interface CognitionReadOptions {
  /** How long a caller holding a complete snapshot waits for the revision check. */
  readonly revisionDeadlineMs?: number;
}

/** Default bound on the revision check once a complete snapshot exists. */
export const COGNITION_REVISION_DEADLINE_MS = 250;

const memos = new WeakMap<
  object,
  { key: string; read: Promise<CognitionSnapshot> }
>();
/** The latest complete snapshot per port, for the orientation ids it was read with. */
const lastComplete = new WeakMap<
  object,
  { idsKey: string; snapshot: CognitionSnapshot }
>();

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
  const [domains, governingIndex, orientation, goals] = await Promise.all([
    port.listDomainsFull(),
    port.listGoverningIndex(),
    firstExisting(port, orientationIds),
    resolveGoals(port),
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
  };
}

function readAt(
  port: CognitionReadPort,
  revision: string,
  orientationIds: readonly string[]
): { read: Promise<CognitionSnapshot>; memoHit: boolean } {
  const idsKey = orientationIds.join("\u0000");
  const key = `${revision}\u0000${idsKey}`;
  const memo = memos.get(port);
  if (memo?.key === key) return { read: memo.read, memoHit: true };
  const read = snapshotAt(port, revision, orientationIds);
  const placed = { key, read };
  memos.set(port, placed);
  // A failed read, or one whose goals were unreadable, is not remembered.
  read.then(
    (snapshot) => {
      if (snapshot.goals.status === "ok")
        lastComplete.set(port, { idsKey, snapshot });
      else if (memos.get(port) === placed) memos.delete(port);
    },
    () => {
      if (memos.get(port) === placed) memos.delete(port);
    }
  );
  return { read, memoHit: false };
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
 * revision query when it is unchanged, bounded by `revisionDeadlineMs` once a
 * complete snapshot exists. `orientationIds` are tried in order (exact node
 * entry first, generic seed last).
 */
export async function readCognitionSnapshot(
  port: CognitionReadPort,
  orientationIds: readonly string[],
  {
    revisionDeadlineMs = COGNITION_REVISION_DEADLINE_MS,
  }: CognitionReadOptions = {}
): Promise<CognitionReadResult> {
  const last = lastComplete.get(port);
  const fallback =
    last?.idsKey === orientationIds.join("\u0000") ? last.snapshot : null;
  const revision = port.currentCommit();
  if (!fallback) {
    const { read, memoHit } = readAt(port, await revision, orientationIds);
    return { snapshot: await read, memoHit, stale: false };
  }
  const checked = await settleWithin(revision, revisionDeadlineMs);
  if (checked.kind !== "value") {
    // Refresh behind the response once the revision arrives.
    revision.then(
      (rev) => readAt(port, rev, orientationIds).read.catch(() => undefined),
      () => undefined
    );
    return { snapshot: fallback, memoHit: true, stale: true };
  }
  const { read, memoHit } = readAt(port, checked.value, orientationIds);
  try {
    return { snapshot: await read, memoHit, stale: false };
  } catch {
    return { snapshot: fallback, memoHit: true, stale: true };
  }
}
