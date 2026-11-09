// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/graph-read`
 * Purpose: Framework-agnostic read of the whole knowledge graph for a node route: revision ETag/304, one pinned projected read per revision, a shared in-flight read, the declared byte budget and one terminal log (task.0059).
 * Scope: Takes a structural port, returns `{ status, headers, body, log }`. Imports no web framework, auth, container or logger; the route only authenticates, calls this and emits `log`.
 * Invariants:
 *   - REVALIDATE_BY_REVISION: `ETag` is the store HEAD. An `If-None-Match` naming it (or `*`, weak or listed) returns 304 with no body and no graph read.
 *   - ONE_READ_PER_REVISION: per port, the latest revision's serialized body is remembered (counts + body only); concurrent callers share one in-flight read; a failed read is forgotten.
 *   - PINNED: the body is exactly the snapshot's revision (the port re-reads HEAD around the projected reads); it is labelled and memoized by that revision.
 *   - WHOLE_CORPUS: never truncated; `budgetExceeded` is logged when the bytes pass the declared per-node/per-edge budget or the whole-response budget, so growth is visible before it hurts.
 *   - BOUNDED: the snapshot runs under the store's graph deadline and admission (`graphTimeoutMs`); a caller's abort ends only that caller's wait, never the shared read.
 *   - NEVER_THROWS: deadline, abort, capacity or any read failure becomes a retryable 503 (`Retry-After: 1`).
 *   - ONE_TERMINAL_LOG: `log` carries counts, bytes and codes only, never values. Event `knowledge.graph_read`.
 * Side-effects: IO (port reads through the injected port)
 * Links: task.0059, packages/knowledge-store/src/domain/history-read.ts
 * @public
 */

import {
  KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET,
  KNOWLEDGE_GRAPH_ENVELOPE_BYTES_BUDGET,
  KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET,
  KNOWLEDGE_GRAPH_RESPONSE_BYTES_BUDGET,
  KnowledgeGraphResponseSchema,
} from "../contracts.js";
import {
  buildKnowledgeGraph,
  type KnowledgeGraphSnapshot,
} from "./knowledge-graph.js";

/** The slice of a knowledge-store port the handler reads. */
export interface KnowledgeGraphReadPort {
  currentCommit(): Promise<string>;
  readKnowledgeGraphSnapshot(options?: {
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphSnapshot>;
}

export interface KnowledgeGraphReadLog {
  readonly event: "knowledge.graph_read";
  readonly status: 200 | 304 | 503;
  readonly outcome: "success" | "error";
  readonly notModified: boolean;
  /** True when the body came from the per-revision memo or a shared in-flight read. */
  readonly memoHit?: boolean;
  readonly nodes?: number;
  readonly edges?: number;
  readonly domains?: number;
  readonly bytes?: number;
  readonly budgetBytes?: number;
  readonly budgetExceeded?: boolean;
  readonly errorCode?: "graph_unavailable";
  /** Set on a failed read so the route may warn with the error class. */
  readonly errorName?: string;
}

export interface KnowledgeGraphReadResult {
  readonly status: 200 | 304 | 503;
  readonly headers: Readonly<Record<string, string>>;
  /** Serialized JSON for 200 and 503; `null` for 304. */
  readonly body: string | null;
  readonly log: KnowledgeGraphReadLog;
}

export interface KnowledgeGraphReadOptions {
  readonly ifNoneMatch?: string | null;
  readonly signal?: AbortSignal;
}

/** Browsers must revalidate every use; never shared by intermediaries. */
export const KNOWLEDGE_GRAPH_CACHE_CONTROL = "private, no-cache, must-revalidate";

const EVENT = "knowledge.graph_read" as const;

interface GraphEntry {
  readonly revision: string;
  readonly body: string;
  readonly nodes: number;
  readonly edges: number;
  readonly domains: number;
  readonly bytes: number;
}

const memos = new WeakMap<
  object,
  { revision: string; read: Promise<GraphEntry> }
>();

/** The byte budget for a graph of this size: envelope + per element, capped by the whole-response budget. */
export function knowledgeGraphBudgetBytes(nodes: number, edges: number): number {
  return Math.min(
    KNOWLEDGE_GRAPH_ENVELOPE_BYTES_BUDGET +
      nodes * KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET +
      edges * KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET,
    KNOWLEDGE_GRAPH_RESPONSE_BYTES_BUDGET
  );
}

const etagOf = (revision: string) => `"${revision}"`;

/** True when an If-None-Match header names this entity tag (or `*`). */
function matches(ifNoneMatch: string | null | undefined, etag: string) {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}

async function snapshotEntry(port: KnowledgeGraphReadPort): Promise<GraphEntry> {
  // Bounded by the store's graph deadline, not by any one caller's connection:
  // the read is shared by every concurrent caller at this revision.
  const snapshot = await port.readKnowledgeGraphSnapshot();
  const graph = KnowledgeGraphResponseSchema.parse({
    revision: snapshot.revision,
    ...buildKnowledgeGraph(snapshot),
  });
  const body = JSON.stringify(graph);
  return {
    revision: snapshot.revision,
    body,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    domains: graph.domains.length,
    bytes: Buffer.byteLength(body),
  };
}

/** Resolve with `read`, or reject as soon as this caller's request is aborted. */
function untilAborted<T>(read: Promise<T>, signal: AbortSignal | undefined) {
  if (!signal) return read;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", abort, { once: true });
    read.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

const unavailable = (errorName?: string): KnowledgeGraphReadResult => ({
  status: 503,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Retry-After": "1",
  },
  body: JSON.stringify({ error: "graph_unavailable", retryable: true }),
  log: {
    event: EVENT,
    status: 503,
    outcome: "error",
    notModified: false,
    errorCode: "graph_unavailable",
    ...(errorName !== undefined && { errorName }),
  },
});

export async function readKnowledgeGraph(
  port: KnowledgeGraphReadPort | null | undefined,
  { ifNoneMatch, signal }: KnowledgeGraphReadOptions = {}
): Promise<KnowledgeGraphReadResult> {
  if (!port) return unavailable();
  try {
    const revision = await port.currentCommit();
    const etag = etagOf(revision);
    if (matches(ifNoneMatch, etag))
      return {
        status: 304,
        headers: { ETag: etag, "Cache-Control": KNOWLEDGE_GRAPH_CACHE_CONTROL },
        body: null,
        log: { event: EVENT, status: 304, outcome: "success", notModified: true },
      };
    let memo = memos.get(port);
    const memoHit = memo?.revision === revision;
    if (!memo || !memoHit) {
      const read = snapshotEntry(port);
      memo = { revision, read };
      memos.set(port, memo);
      const placed = memo;
      read.then(
        // A commit landed between HEAD and the snapshot: memoize the true revision.
        (entry) => {
          if (memos.get(port) === placed && entry.revision !== revision)
            memos.set(port, { revision: entry.revision, read });
        },
        () => {
          if (memos.get(port) === placed) memos.delete(port);
        }
      );
    }
    const entry = await untilAborted(memo.read, signal);
    const budgetBytes = knowledgeGraphBudgetBytes(entry.nodes, entry.edges);
    return {
      status: 200,
      headers: {
        ETag: etagOf(entry.revision),
        "Cache-Control": KNOWLEDGE_GRAPH_CACHE_CONTROL,
        "Content-Type": "application/json",
      },
      body: entry.body,
      log: {
        event: EVENT,
        status: 200,
        outcome: "success",
        notModified: false,
        memoHit,
        nodes: entry.nodes,
        edges: entry.edges,
        domains: entry.domains,
        bytes: entry.bytes,
        budgetBytes,
        budgetExceeded: entry.bytes > budgetBytes,
      },
    };
  } catch (error) {
    return unavailable((error as Error)?.name);
  }
}
