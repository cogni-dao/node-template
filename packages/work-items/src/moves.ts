// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/moves`
 * Purpose: A work item names the metrics it moves, each with a baseline pinned once by the server (story.0033).
 * Scope: Types, rules, the two narrow metric ports, the pin-once reconcile and the read-time judgement. No I/O of its own; this package never imports `@cogni-dao/metrics`.
 * Invariants:
 *   - MOVES_BOUNDED: at most 3 entries, metric ids unique, each id 1..40 characters; `[]` is allowed and means "moves nothing" (the required edit reason says why).
 *   - METRIC_IS_RESOLVED: every id in a write is checked with `EntryResolver` under rule `"metric"` (registered and not deprecated); an unknown id is `EntryUnresolvedError`.
 *   - BASELINE_IS_SERVER_OWNED: clients send `{ metricId, direction }` only. The server fills `baselineObservationId` when an entry first appears and never changes it; removing an entry and adding it back pins a new baseline.
 *   - NULL_BASELINE_READS_UNKNOWN: with no observation to pin, the baseline stays `null` and the read says `unknown` (reason `no_baseline`), never zero.
 *   - READ_IS_BOUNDED: judging an item looks up at most one baseline and one latest reading per move, within one deadline; a failed lookup reads `unknown`.
 * Side-effects: none (the ports it calls do I/O)
 * Links: hub metric-foundation-design ("Metrics serve KPIs; work moves metrics"), packages/work-items/src/cites.ts
 * @public
 */

import {
  EntryResolverUnavailableError,
  EntryUnresolvedError,
  type EntryResolver,
} from "./cites.js";

export const MOVES_MAX = 3;
export const MOVE_METRIC_ID_MAX = 40;
export const MOVE_OBSERVATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Wall-clock budget for the baseline pin of one write, and for judging one item. */
export const MOVES_DEADLINE_MS = 3_000;

export type MoveDirection = "up" | "down";

/** What a client may send. Anything else on an entry is dropped. */
export interface MoveInput {
  readonly metricId: string;
  readonly direction: MoveDirection;
}

/** What the store keeps. */
export interface WorkItemMove extends MoveInput {
  /** The metric reading that was newest when the entry first appeared; `null` when there was none. */
  readonly baselineObservationId: string | null;
}

/** The newest good reading of a metric at the moment a move first appears. */
export interface MetricBaselinePort {
  /** The id of the metric's latest good observation, or `null` when it has none. Reads only. */
  latestObservationId(
    metricId: string,
    signal: AbortSignal
  ): Promise<string | null>;
}

/** One reading as a work item shows it. */
export interface MoveReading {
  readonly value: number;
  readonly observedAt: string;
}

/** Read side of the same service, narrow enough that this package stays free of the metrics package. */
export interface MoveReadingPort {
  /** The reading with this id, or `null` when it is gone, has no value, or is not this metric's. */
  observation(
    metricId: string,
    observationId: string,
    signal: AbortSignal
  ): Promise<MoveReading | null>;
  /** The metric's latest good reading, or `null` when there is none. */
  latest(metricId: string, signal: AbortSignal): Promise<MoveReading | null>;
}

export type MovedState = "as_declared" | "against" | "flat" | "unknown";
export type MoveUnknownReason =
  | "no_baseline"
  | "baseline_unreadable"
  | "no_current"
  | "metrics_unavailable";

export interface JudgedMove extends WorkItemMove {
  readonly baseline: MoveReading | null;
  readonly current: MoveReading | null;
  readonly moved: MovedState;
  readonly unknownReason?: MoveUnknownReason;
}

/** Problems with a `moves` write, one line each; empty when valid. */
export function moveIssues(moves: unknown): string[] {
  if (!Array.isArray(moves)) return ["moves must be an array"];
  const issues: string[] = [];
  if (moves.length > MOVES_MAX)
    issues.push(`moves must hold at most ${MOVES_MAX} entries`);
  const seen = new Set<string>();
  for (const [i, move] of moves.entries()) {
    const entry = move as { metricId?: unknown; direction?: unknown } | null;
    const id = entry?.metricId;
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > MOVE_METRIC_ID_MAX
    ) {
      issues.push(`moves[${i}].metricId must be 1-${MOVE_METRIC_ID_MAX} characters`);
    } else {
      if (seen.has(id)) issues.push(`moves[${i}].metricId repeats ${id}`);
      seen.add(id);
    }
    if (entry?.direction !== "up" && entry?.direction !== "down")
      issues.push(`moves[${i}].direction must be "up" or "down"`);
  }
  return issues;
}

/** A `moves` write that breaks the rules (the zod schema normally says so first). */
export class MovesInvalidError extends Error {
  readonly code = "moves_invalid" as const;
  constructor(readonly issues: readonly string[]) {
    super(`Invalid moves: ${issues.join("; ")}`);
    this.name = "MovesInvalidError";
  }
}

/** The write names a metric but this node wires no metric resolver or no baseline reader; nothing was written. */
export class MovesUnsupportedError extends Error {
  readonly code = "moves_unsupported" as const;
  constructor() {
    super(
      "moves are not supported: no metric resolver or baseline reader is wired on this node"
    );
    this.name = "MovesUnsupportedError";
  }
}

/**
 * The stored column as entries. A value that is not an array reads as absent;
 * an entry that is not a valid move is skipped, so one bad row never fails a read.
 */
export function parseStoredMoves(value: unknown): WorkItemMove[] | undefined {
  if (value === null || value === undefined) return undefined;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(parsed)) return undefined;
  const moves: WorkItemMove[] = [];
  for (const entry of parsed) {
    const e = entry as {
      metricId?: unknown;
      direction?: unknown;
      baselineObservationId?: unknown;
    } | null;
    if (typeof e?.metricId !== "string" || !e.metricId) continue;
    if (e.direction !== "up" && e.direction !== "down") continue;
    moves.push({
      metricId: e.metricId,
      direction: e.direction,
      baselineObservationId:
        typeof e.baselineObservationId === "string" &&
        MOVE_OBSERVATION_ID_PATTERN.test(e.baselineObservationId)
          ? e.baselineObservationId
          : null,
    });
  }
  return moves;
}

/** Run `task` with an abort signal that fires after `deadlineMs`. */
async function withDeadline<T>(
  deadlineMs: number,
  task: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => Error
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(onTimeout());
    }, deadlineMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unresolvedIds(error: unknown): readonly string[] | undefined {
  if (error instanceof EntryUnresolvedError) return error.ids;
  const named = error as { name?: unknown; ids?: unknown } | null;
  return named?.name === "EntryUnresolvedError" &&
    Array.isArray(named.ids) &&
    named.ids.every((id) => typeof id === "string")
    ? (named.ids as string[])
    : undefined;
}

/**
 * Build the entries a write stores. Pure on its inputs and two injected ports.
 *
 *   1. every incoming id is resolved under rule `"metric"` (unknown or deprecated: `EntryUnresolvedError`);
 *   2. an id already on the item keeps its stored baseline, whatever the client sent;
 *   3. an id that is new reads the metric's latest good observation once; none: `null`.
 *
 * The caller holds the writer lock, so "already on the item" is the row the write replaces.
 */
export async function pinMoves(
  existing: readonly WorkItemMove[] | undefined,
  incoming: readonly MoveInput[],
  deps: {
    readonly resolver: EntryResolver;
    readonly baselines: MetricBaselinePort;
    readonly deadlineMs?: number;
  }
): Promise<WorkItemMove[]> {
  if (!incoming.length) return [];
  const deadlineMs = deps.deadlineMs ?? MOVES_DEADLINE_MS;
  const unavailable = () =>
    new EntryResolverUnavailableError(
      `Metric lookup did not answer within ${deadlineMs}ms; nothing was written`
    );
  const kept = new Map((existing ?? []).map((m) => [m.metricId, m]));
  return withDeadline(
    deadlineMs,
    async (signal) => {
      try {
        await deps.resolver.resolve(
          incoming.map((m) => ({ id: m.metricId })),
          "metric",
          signal
        );
      } catch (error) {
        const ids = unresolvedIds(error);
        if (ids) throw new EntryUnresolvedError(ids, "moves");
        throw error instanceof EntryResolverUnavailableError
          ? error
          : new EntryResolverUnavailableError(
              "Metric resolver is unavailable; nothing was written"
            );
      }
      const pinned: WorkItemMove[] = [];
      for (const move of incoming) {
        const prior = kept.get(move.metricId);
        if (prior) {
          pinned.push({
            metricId: move.metricId,
            direction: move.direction,
            baselineObservationId: prior.baselineObservationId,
          });
          continue;
        }
        let observationId: string | null;
        try {
          observationId = await deps.baselines.latestObservationId(
            move.metricId,
            signal
          );
        } catch {
          throw new EntryResolverUnavailableError(
            `Metric baseline for ${move.metricId} could not be read; nothing was written`
          );
        }
        pinned.push({
          metricId: move.metricId,
          direction: move.direction,
          baselineObservationId:
            observationId !== null &&
            MOVE_OBSERVATION_ID_PATTERN.test(observationId)
              ? observationId
              : null,
        });
      }
      return pinned;
    },
    unavailable
  );
}

/** The verdict of one move from its two readings. Never throws; absent data is `unknown`. */
export function judgeMove(
  direction: MoveDirection,
  baseline: MoveReading | null,
  current: MoveReading | null
): MovedState {
  if (!baseline || !current) return "unknown";
  if (!Number.isFinite(baseline.value) || !Number.isFinite(current.value))
    return "unknown";
  if (current.value === baseline.value) return "flat";
  const up = current.value > baseline.value;
  return up === (direction === "up") ? "as_declared" : "against";
}

/**
 * Read both ends of each move and judge it. At most one baseline lookup and one
 * latest lookup per move, run for the moves together within one deadline.
 * A missing baseline skips the latest lookup: the answer is `unknown` either way.
 * `readings` absent (no metrics service on this node) reads every move `unknown`.
 */
export async function judgeMoves(
  moves: readonly WorkItemMove[],
  readings: MoveReadingPort | undefined,
  options: { readonly deadlineMs?: number } = {}
): Promise<JudgedMove[]> {
  const deadlineMs = options.deadlineMs ?? MOVES_DEADLINE_MS;
  const bounded = moves.slice(0, MOVES_MAX);
  const unknown = (
    move: WorkItemMove,
    unknownReason: MoveUnknownReason,
    baseline: MoveReading | null = null
  ): JudgedMove => ({
    ...move,
    baseline,
    current: null,
    moved: "unknown",
    unknownReason,
  });
  if (!readings) return bounded.map((m) => unknown(m, "metrics_unavailable"));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A port that ignores the signal must not hold the read: at the deadline every move reads unknown.
  const expired = new Promise<JudgedMove[]>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(bounded.map((m) => unknown(m, "metrics_unavailable")));
    }, deadlineMs);
  });
  const one = async (move: WorkItemMove): Promise<JudgedMove> => {
    if (move.baselineObservationId === null) return unknown(move, "no_baseline");
    let baseline: MoveReading | null = null;
    try {
      baseline = await readings.observation(
        move.metricId,
        move.baselineObservationId,
        controller.signal
      );
    } catch {
      baseline = null;
    }
    if (!baseline) return unknown(move, "baseline_unreadable");
    let current: MoveReading | null = null;
    try {
      current = await readings.latest(move.metricId, controller.signal);
    } catch {
      current = null;
    }
    if (!current) return unknown(move, "no_current", baseline);
    return {
      ...move,
      baseline,
      current,
      moved: judgeMove(move.direction, baseline, current),
    };
  };
  try {
    return await Promise.race([Promise.all(bounded.map(one)), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
