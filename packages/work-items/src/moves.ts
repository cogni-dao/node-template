// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/moves`
 * Purpose: A work item names the metrics it moves, each with a baseline pinned once by the server (story.0033).
 * Scope: Types, rules, the two narrow metric ports, the pin-once reconcile and the read-time judgement. No I/O of its own; this package never imports `@cogni-dao/metrics`.
 * Invariants:
 *   - MOVES_BOUNDED: at most 3 entries, metric ids unique, each id 1..40 characters; `[]` is allowed and means "moves nothing" (the required edit reason says why).
 *   - NEW_ENTRIES_ARE_RESOLVED: each id that is NEW on the item is checked with `EntryResolver` under rule `"metric"` (registered and not deprecated); an unknown or deprecated id is `EntryUnresolvedError`. An entry already on the item is kept as it is, so a metric deprecated later never blocks an unrelated save; a read shows it as `unknown` with `metric_deprecated`.
 *   - BASELINE_IS_SERVER_OWNED: clients send `{ metricId, direction }` only. The server fills `baselineObservationId` when an entry first appears and never changes it; removing an entry and adding it back pins a new baseline.
 *   - NULL_BASELINE_READS_UNKNOWN: with no observation to pin, the baseline stays `null` and the read says `unknown` (reason `no_baseline`), never zero.
 *   - BASELINE_FAILURE_IS_ITS_OWN_ERROR: a baseline reader that fails or runs past the deadline is `MetricBaselineUnavailableError` (503 `metric_baseline_unavailable`); a resolver failure stays `EntryResolverUnavailableError`.
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

export type MoveDirection = "up" | "down" | null;

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
  latestObservationId(metricId: string, signal: AbortSignal): Promise<string | null>;
}

/** One reading as a work item shows it. */
export interface MoveReading {
  readonly value: number | null;
  readonly observedAt: string | null;
  readonly id?: string;
  readonly metricId?: string;
  readonly metricTitle?: string;
  readonly definitionRevision?: string;
  readonly definitionHash?: string;
  readonly calculatorVersion?: string;
  readonly paramsHash?: string;
  readonly node?: string;
  readonly environment?: string;
  readonly dataScope?: string;
  readonly window?: { readonly start: string; readonly end: string };
  readonly sourceWatermarks?: { readonly source: string; readonly asOf: string | null }[];
  readonly status?: "pending" | "ok" | "unavailable" | "error";
  readonly unit?: string;
  readonly reason?: string | null;
  readonly evidenceRefs?: string[];
  readonly viewState?: "ok" | "stale" | "pending" | "unavailable" | "error";
  readonly maxAgeSeconds?: number;
}

/**
 * A `MoveReadingPort` throws this when the metric itself is gone (unknown or deprecated), as
 * opposed to a reading that is missing. The judge reads it as `unknown` / `metric_deprecated`.
 */
export class MoveMetricGoneError extends Error {
  constructor(readonly metricId: string) {
    super(`Metric is unknown or deprecated: ${metricId}`);
    this.name = "MoveMetricGoneError";
  }
}

/** The baseline reader failed or ran past its deadline; nothing was written. */
export class MetricBaselineUnavailableError extends Error {
  readonly code = "metric_baseline_unavailable" as const;
  constructor(message = "Metric baseline is unavailable; retry shortly") {
    super(message);
    this.name = "MetricBaselineUnavailableError";
  }
}

/** Read side of the same service, narrow enough that this package stays free of the metrics package. */
export interface MoveReadingPort {
  batch?(
    moves: readonly WorkItemMove[],
    signal: AbortSignal,
  ): Promise<
    readonly {
      baseline: MoveReading | null;
      current: MoveReading | null;
      unknownReason?: MoveUnknownReason;
    }[]
  >;
  assess?(
    direction: MoveDirection,
    baseline: MoveReading | null,
    current: MoveReading | null,
  ): MovedState;
  /** The reading with this id, or `null` when it is gone, has no value, or is not this metric's. Throws `MoveMetricGoneError` when the metric is unknown or deprecated. */
  observation(
    metricId: string,
    observationId: string,
    signal: AbortSignal,
  ): Promise<MoveReading | null>;
  /** The latest attempt, including failed or stale attempts, or null if absent. */
  latest(metricId: string, signal: AbortSignal): Promise<MoveReading | null>;
}

export type MovedState = "as_declared" | "against" | "flat" | "unknown" | null;
export type MoveUnknownReason =
  | "no_baseline"
  | "baseline_unreadable"
  | "no_current"
  | "metric_deprecated"
  | "incompatible_reading"
  | "projection_budget"
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
  if (moves.length > MOVES_MAX) issues.push(`moves must hold at most ${MOVES_MAX} entries`);
  const seen = new Set<string>();
  for (const [i, move] of moves.entries()) {
    const entry = move as { metricId?: unknown; direction?: unknown } | null;
    const id = entry?.metricId;
    if (typeof id !== "string" || id.length < 1 || id.length > MOVE_METRIC_ID_MAX) {
      issues.push(`moves[${i}].metricId must be 1-${MOVE_METRIC_ID_MAX} characters`);
    } else {
      if (seen.has(id)) issues.push(`moves[${i}].metricId repeats ${id}`);
      seen.add(id);
    }
    if (entry?.direction !== "up" && entry?.direction !== "down" && entry?.direction !== null)
      issues.push(`moves[${i}].direction must be "up", "down" or null`);
    // Old deployed readers discard null-direction entries. Enable these writes only
    // after every active reader has been upgraded to preserve them.
    if (entry?.direction === null)
      issues.push(`moves[${i}].direction null is not enabled until readers are upgraded`);
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
    super("moves are not supported: no metric resolver or baseline reader is wired on this node");
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
    if (e.direction !== "up" && e.direction !== "down" && e.direction !== null) continue;
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
  onTimeout: () => Error,
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
    return await Promise.race([Promise.resolve().then(() => task(controller.signal)), timeout]);
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
 *   1. an id already on the item keeps its stored baseline, whatever the client sent, and is NOT
 *      checked again: a metric deprecated since never blocks the save;
 *   2. an id that is new is resolved under rule `"metric"` (unknown or deprecated:
 *      `EntryUnresolvedError`), then reads the metric's latest good observation once; none: `null`.
 *
 * With nothing new the resolver is not called. The caller holds the writer lock on a patch, so
 * "already on the item" is the row the write replaces; a create passes no existing entries.
 */
export async function pinMoves(
  existing: readonly WorkItemMove[] | undefined,
  incoming: readonly MoveInput[],
  deps: {
    readonly resolver: EntryResolver;
    readonly baselines: MetricBaselinePort;
    readonly deadlineMs?: number;
  },
): Promise<WorkItemMove[]> {
  if (!incoming.length) return [];
  const deadlineMs = deps.deadlineMs ?? MOVES_DEADLINE_MS;
  const kept = new Map((existing ?? []).map((m) => [m.metricId, m]));
  const fresh = incoming.filter((m) => !kept.has(m.metricId));
  let phase: "resolve" | "baseline" = "resolve";
  return withDeadline(
    deadlineMs,
    async (signal) => {
      if (fresh.length) {
        try {
          await deps.resolver.resolve(
            fresh.map((m) => ({ id: m.metricId })),
            "metric",
            signal,
          );
        } catch (error) {
          const ids = unresolvedIds(error);
          if (ids) throw new EntryUnresolvedError(ids, "moves");
          throw error instanceof EntryResolverUnavailableError
            ? error
            : new EntryResolverUnavailableError(
                "Metric resolver is unavailable; nothing was written",
              );
        }
      }
      phase = "baseline";
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
          observationId = await deps.baselines.latestObservationId(move.metricId, signal);
        } catch {
          throw new MetricBaselineUnavailableError(
            `Metric baseline for ${move.metricId} could not be read; nothing was written`,
          );
        }
        pinned.push({
          metricId: move.metricId,
          direction: move.direction,
          baselineObservationId:
            observationId !== null && MOVE_OBSERVATION_ID_PATTERN.test(observationId)
              ? observationId
              : null,
        });
      }
      return pinned;
    },
    () =>
      phase === "baseline"
        ? new MetricBaselineUnavailableError(
            `Metric baseline did not answer within ${deadlineMs}ms; nothing was written`,
          )
        : new EntryResolverUnavailableError(
            `Metric lookup did not answer within ${deadlineMs}ms; nothing was written`,
          ),
  );
}

const isMetricGone = (error: unknown): boolean =>
  error instanceof MoveMetricGoneError ||
  (error as { name?: unknown } | null)?.name === "MoveMetricGoneError";

/** @deprecated Legacy numeric helper; runtime projections delegate to the metrics port. */
export function judgeMove(
  direction: MoveDirection,
  baseline: MoveReading | null,
  current: MoveReading | null,
): MovedState {
  if (direction === null) return null;
  if (!baseline || !current) return "unknown";
  if (
    baseline.value === null ||
    current.value === null ||
    !Number.isFinite(baseline.value) ||
    !Number.isFinite(current.value)
  )
    return "unknown";
  if (current.value === baseline.value) return "flat";
  const up = current.value > baseline.value;
  return up === (direction === "up") ? "as_declared" : "against";
}

/**
 * Read both ends of each move and judge it. At most one baseline lookup and one
 * latest lookup per move, run for the moves together within one deadline.
 * A missing baseline still reads the current attempt; the directional verdict stays `unknown`.
 * `readings` absent (no metrics service on this node) reads every move `unknown`.
 */
export async function judgeMoves(
  moves: readonly WorkItemMove[],
  readings: MoveReadingPort | undefined,
  options: { readonly deadlineMs?: number } = {},
): Promise<JudgedMove[]> {
  const deadlineMs = options.deadlineMs ?? MOVES_DEADLINE_MS;
  const bounded = moves.slice(0, MOVES_MAX);
  const unknown = (
    move: WorkItemMove,
    unknownReason: MoveUnknownReason,
    baseline: MoveReading | null = null,
  ): JudgedMove => ({
    ...move,
    baseline,
    current: null,
    moved: move.direction === null ? null : "unknown",
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
    if (move.baselineObservationId === null) {
      try {
        const current = await readings.latest(move.metricId, controller.signal);
        return { ...unknown(move, "no_baseline"), current };
      } catch (error) {
        return unknown(move, isMetricGone(error) ? "metric_deprecated" : "no_baseline");
      }
    }
    let baseline: MoveReading | null = null;
    try {
      baseline = await readings.observation(
        move.metricId,
        move.baselineObservationId,
        controller.signal,
      );
    } catch (error) {
      if (isMetricGone(error)) return unknown(move, "metric_deprecated");
      baseline = null;
    }
    if (!baseline) {
      try {
        const current = await readings.latest(move.metricId, controller.signal);
        return { ...unknown(move, "baseline_unreadable"), current };
      } catch (error) {
        return unknown(move, isMetricGone(error) ? "metric_deprecated" : "baseline_unreadable");
      }
    }
    let current: MoveReading | null = null;
    try {
      current = await readings.latest(move.metricId, controller.signal);
    } catch (error) {
      if (isMetricGone(error)) return unknown(move, "metric_deprecated", baseline);
      current = null;
    }
    if (!current) return unknown(move, "no_current", baseline);
    let moved: MovedState = move.direction === null ? null : "unknown";
    try {
      if (readings.assess) moved = readings.assess(move.direction, baseline, current);
    } catch {
      // An unavailable assessor never turns readings into a directional claim.
    }
    return {
      ...move,
      baseline,
      current,
      moved,
      ...(moved === "unknown" ? { unknownReason: "incompatible_reading" as const } : {}),
    };
  };
  try {
    return await Promise.race([Promise.all(bounded.map(one)), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Enrich at most 100 items through one batch with a shared deadline. */
export async function judgeMoveSummaries<T extends { moves?: WorkItemMove[] | undefined }>(
  items: readonly T[],
  readings: MoveReadingPort | undefined,
  bounds: number | { readonly signal?: AbortSignal; readonly deadline?: number } = {},
): Promise<T[]> {
  const options = typeof bounds === "number" ? { deadline: Date.now() + bounds } : bounds;
  const result = (await Promise.all(
    items.map(async (item) =>
      item.moves?.length
        ? {
            ...item,
            moves: (
              await judgeMoves(item.moves, undefined)
            ).map((move) => ({
              ...move,
              unknownReason: readings?.batch
                ? ("projection_budget" as const)
                : ("metrics_unavailable" as const),
            })),
          }
        : item,
    ),
  )) as T[];
  if (!readings?.batch) return result;
  const refs = items
    .slice(0, 100)
    .flatMap((item, index) =>
      (item.moves ?? []).slice(0, MOVES_MAX).map((move) => ({ index, move })),
    );
  if (!refs.length || options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) return result;
  const controller = new AbortController();
  const deadlineMs = Math.min(MOVES_DEADLINE_MS, options.deadline === undefined ? MOVES_DEADLINE_MS : options.deadline - Date.now());
  if (deadlineMs <= 0) return result;
  let cancel: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => { controller.abort(); reject(new Error("metric batch cancelled")); };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
    if (controller.signal.aborted) return await cancelled;
    const data = await Promise.race([
      cancelled,
      readings.batch(
        refs.map((ref) => ref.move),
        controller.signal,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("metric batch timed out"));
        }, deadlineMs);
      }),
    ]);
    const grouped = new Map<number, JudgedMove[]>();
    refs.forEach(({ index, move }, i) => {
      const pair = data[i];
      let moved: MovedState = move.direction === null ? null : "unknown";
      if (pair?.baseline && pair.current && readings.assess) {
        try {
          moved = readings.assess(move.direction, pair.baseline, pair.current);
        } catch {
          /* fail closed */
        }
      }
      const unknownReason =
        pair?.unknownReason ??
        (!move.baselineObservationId
          ? "no_baseline"
          : !pair?.baseline
            ? "baseline_unreadable"
            : !pair.current
              ? "no_current"
              : moved === "unknown"
                ? "incompatible_reading"
                : undefined);
      const entries = grouped.get(index) ?? [];
      entries.push({
        ...move,
        baseline: pair?.baseline ?? null,
        current: pair?.current ?? null,
        moved,
        ...(unknownReason ? { unknownReason } : {}),
      });
      grouped.set(index, entries);
    });
    grouped.forEach((moves, index) => {
      const item = items[index];
      if (item) result[index] = { ...item, moves };
    });
  } catch {
    /* preserve unknown results on unavailable batch */
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
  }
  return result;
}
