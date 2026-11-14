// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/envelope`
 * Purpose: The ONE assembly of the single-item work item envelope (task.0118): the stored item plus each
 *   move's readings and verdict, its metric, KPI and goal, and optionally the first page of citation links.
 * Scope: Composition over two injected ports (`MoveReadingPort`, `ItemLinksPort`). No I/O of its own; never imports
 *   `@cogni-dao/metrics` or `@cogni-dao/knowledge-store`. The node supplies both ports.
 * Invariants:
 *   - ONE_COMPOSITION: the HTTP facade and the agent tool's capability both call `composeItemEnvelope`, so a node
 *     that bumps this package gets the same envelope in both without porting app code.
 *   - ALL_READS_BOUNDED: the chain, the readings and the links share one deadline (MOVES_DEADLINE_MS ceiling) and the
 *     caller's signal; a hung port cannot hold the read.
 *   - UNAVAILABLE_NOT_EMPTY: a chain that did not resolve reads `context: "unavailable"` and links that did not read
 *     are `{ items: [], nextCursor: null, unavailable: true }`; neither is ever an invented or empty answer.
 *   - DEGRADE_IS_LOGGED_ONCE: each degraded part (chain, links) emits one `EnvelopeDegradedEvent` per read, carrying
 *     only an error name, never row content.
 *   - NEVER_THROWS: a port failure degrades its part; the item is always returned.
 *   - ARTIFACTS_ONE_QUERY (task.0028): with an `artifacts` port the read adds the latest artifact of each kind (at most four) through one bounded call; a failure, or one stored row that does not parse as an artifact, reads `artifacts: { unavailable: true }`, never an empty answer and never a 500.
 * Side-effects: none (the ports it calls do I/O)
 * Links: packages/work-items/src/moves.ts, hub agent-tool-context-envelope
 * @public
 */

import {
  toLatestArtifacts,
  type WorkItemArtifact,
  WorkItemArtifactSummarySchema,
  type WorkItemArtifactsLatest,
} from "./artifacts.js";
import type { WorkItemLinks } from "./contracts.js";
import {
  judgeMoveSummaries,
  type MoveReadingPort,
  readMoveContext,
  runBounded,
  type WorkItemMove,
  withMoveContext,
} from "./moves.js";

/** First page of an item's citation links. The node adapts its citations read to this port. */
export interface ItemLinksPort {
  /** At most five links plus `nextCursor`. Throws when the store cannot answer. */
  firstPage(id: string, signal: AbortSignal): Promise<WorkItemLinks>;
}

/** The latest artifact of each kind for an item (task.0028). The node adapts its artifact store to this port. */
export interface ItemArtifactsPort {
  /** At most one artifact per kind (four rows), newest of each. Throws when the store cannot answer. */
  latest(id: string, signal: AbortSignal): Promise<readonly WorkItemArtifact[]>;
}

/** One degraded part of one envelope read. `reason` is an error name or a fixed code, never content. */
export interface EnvelopeDegradedEvent {
  readonly part: "chain" | "links" | "artifacts";
  readonly workItemId: string;
  readonly reason: string;
  /** Moves whose chain did not resolve, and how many were asked (chain only). */
  readonly unresolved?: number;
  readonly of?: number;
}

export interface ItemEnvelopeDeps {
  readonly readings?: MoveReadingPort | undefined;
  readonly links?: ItemLinksPort | undefined;
  /** Adds `artifacts`: the latest review or validation of each kind. No port: the part is absent. */
  readonly artifacts?: ItemArtifactsPort | undefined;
  readonly log?: ((event: EnvelopeDegradedEvent) => void) | undefined;
}

export interface ItemEnvelopeOptions {
  /** Stops every read before its next step. */
  readonly signal?: AbortSignal;
  /** Epoch ms bound for every read; the ceiling is MOVES_DEADLINE_MS from now. */
  readonly deadline?: number;
  /** Add `links`: the first page of citation links. */
  readonly includeLinks?: boolean;
  /** Set false to skip the metric, KPI and goal chain (callers that need only the stored move ids). */
  readonly chain?: boolean;
  /** Set false to skip the artifacts read (callers that need only the item). Default: read them when a port is wired. */
  readonly artifacts?: boolean;
}

const UNAVAILABLE_LINKS: WorkItemLinks = { items: [], nextCursor: null, unavailable: true };
const UNAVAILABLE_ARTIFACTS: WorkItemArtifactsLatest = { unavailable: true };

const reasonOf = (error: unknown): string => {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "error";
};

export async function composeItemEnvelope<T extends { id: string; moves?: WorkItemMove[] | undefined }>(
  item: T,
  deps: ItemEnvelopeDeps,
  options: ItemEnvelopeOptions = {},
): Promise<T & { links?: WorkItemLinks; artifacts?: WorkItemArtifactsLatest }> {
  const emit = (event: EnvelopeDegradedEvent) => {
    try {
      deps.log?.(event);
    } catch {
      // A logger never fails a read.
    }
  };
  const ids = item.moves?.map((move) => move.metricId) ?? [];
  const wantChain = options.chain !== false && ids.length > 0;
  let chainReason = deps.readings?.context ? "unavailable" : "no_port";
  const readLinks = async (): Promise<WorkItemLinks> => {
    const port = deps.links;
    if (!port) {
      emit({ part: "links", workItemId: item.id, reason: "no_port" });
      return UNAVAILABLE_LINKS;
    }
    try {
      return await runBounded((signal) => port.firstPage(item.id, signal), options);
    } catch (error) {
      emit({ part: "links", workItemId: item.id, reason: reasonOf(error) });
      return UNAVAILABLE_LINKS;
    }
  };
  const readArtifacts = async (): Promise<WorkItemArtifactsLatest | undefined> => {
    const port = deps.artifacts;
    if (!port || options.artifacts === false) return undefined;
    try {
      const stored = await runBounded((signal) => port.latest(item.id, signal), options);
      // A stored row the wire cannot carry degrades the part; it never fails the item read (a 500).
      const rows = stored.map((row) => WorkItemArtifactSummarySchema.safeParse(row));
      if (rows.some((row) => !row.success)) {
        emit({ part: "artifacts", workItemId: item.id, reason: "invalid_row" });
        return UNAVAILABLE_ARTIFACTS;
      }
      return toLatestArtifacts(
        rows.flatMap((row) => (row.success ? [row.data] : [])),
      );
    } catch (error) {
      emit({ part: "artifacts", workItemId: item.id, reason: reasonOf(error) });
      return UNAVAILABLE_ARTIFACTS;
    }
  };
  const [judged, context, links, artifacts] = await Promise.all([
    judgeMoveSummaries([item], deps.readings, options).then((rows) => rows[0] ?? item),
    wantChain
      ? readMoveContext(ids, deps.readings, options, (error) => {
          chainReason = reasonOf(error);
        })
      : undefined,
    options.includeLinks ? readLinks() : undefined,
    readArtifacts(),
  ]);
  let out: T = judged;
  if (wantChain) {
    out = withMoveContext(judged, context);
    const unresolved = (out.moves ?? []).filter(
      (move) => (move as { context?: unknown }).context === "unavailable",
    ).length;
    if (unresolved)
      emit({
        part: "chain",
        workItemId: item.id,
        reason: context ? "unresolved" : chainReason,
        unresolved,
        of: ids.length,
      });
  }
  return {
    ...out,
    ...(links ? { links } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}
