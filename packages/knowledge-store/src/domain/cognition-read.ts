// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/cognition-read`
 * Purpose: The hub inputs of a node's session cognition bundle, read once per store revision (bug.0018).
 * Scope: Takes a structural port, returns plain data plus `memoHit`. Imports no web framework, auth, container, metrics or logger; the route renders and logs.
 * Invariants:
 *   - INDEX_ONLY: domains with counts, the projected governing index, active goals and ONE orientation body. No per-domain scan, no other body.
 *   - ONE_READ_PER_REVISION: per port, the latest revision's snapshot is remembered; concurrent callers share one in-flight read; a failed read or an unreadable goals section is forgotten.
 *   - NEVER_STALE_PAST_HEAD: HEAD is read before the index reads, so the snapshot is at least as new as its revision label; a new commit changes the key.
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
}

const memos = new WeakMap<
  object,
  { key: string; read: Promise<CognitionSnapshot> }
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

/**
 * Read the cognition hub inputs at the store's current revision. Costs one
 * HEAD query when the revision is unchanged. `orientationIds` are tried in
 * order (exact node entry first, generic seed last).
 */
export async function readCognitionSnapshot(
  port: CognitionReadPort,
  orientationIds: readonly string[]
): Promise<CognitionReadResult> {
  const revision = await port.currentCommit();
  const key = `${revision}\u0000${orientationIds.join("\u0000")}`;
  let memo = memos.get(port);
  const memoHit = memo?.key === key;
  if (!memo || !memoHit) {
    const read = snapshotAt(port, revision, orientationIds);
    const placed = { key, read };
    memo = placed;
    memos.set(port, placed);
    // A failed read, or one whose goals were unreadable, is not remembered.
    read.then(
      (snapshot) => {
        if (snapshot.goals.status !== "ok" && memos.get(port) === placed)
          memos.delete(port);
      },
      () => {
        if (memos.get(port) === placed) memos.delete(port);
      }
    );
  }
  return { snapshot: await memo.read, memoHit };
}
