// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Bounded read admission, following Work's native-settlement accounting.
 * Never reserve, cancel, close or replace a borrowed pool. postgres.js cancel()
 * opens an unbounded auxiliary connection; caller abort is not native settlement.
 * Retain permits after deadlines/aborts until a server result arrives. Definitive
 * closed-connection errors release at once; unknown transport outcomes retain
 * capacity for a bounded quarantine (4x deadline), so a blip cannot 503 forever.
 */
import type { Sql } from "postgres";
import { KnowledgeBusyError } from "../../port/knowledge-store.port.js";

type Rows = readonly Record<string, unknown>[];
type Waiter = { start(): void; fail(): void };
type Lane = { active: number; width: number; waiting: Waiter[] };
const lanes = new WeakMap<object, Lane>();
const unavailable = () =>
  new KnowledgeBusyError(
    "Knowledge read deadline or capacity unavailable; retry shortly"
  );

/** Unknown transport outcomes retain their permit for this many deadlines, then release. */
const QUARANTINE_DEADLINES = 4;
const CLOSED_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "ECONNRESET",
  "ECONNREFUSED",
]);
function isSettled(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "PostgresError") return true;
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === "string" && CLOSED_CODES.has(code)) ||
    /socket.*closed|connection.*closed/i.test(error.message)
  );
}
function release(lane: Lane) {
  lane.active--;
  lane.waiting.shift()?.start();
}

export async function readBrowseWithinBudget<T>(
  pool: Sql,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (query: (text: string) => Promise<Rows>) => Promise<T>
): Promise<T> {
  let lane = lanes.get(pool);
  if (!lane) {
    const max = pool.options?.max;
    // Leave one connection for unrelated readers on multi-connection pools.
    // This is shared across all adapter instances borrowing the same pool.
    lane = {
      active: 0,
      width: Number.isInteger(max) && max > 1 ? max - 1 : 1,
      waiting: [],
    };
    lanes.set(pool, lane);
  }
  const state = lane;
  if (signal?.aborted || state.waiting.length >= 32) throw unavailable();
  const deadline = Date.now() + timeoutMs;
  let expired = false;
  let uncertain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: Waiter | undefined;
  let rejectCaller: (error: Error) => void = () => undefined;
  const stop = () => {
    expired = true;
    if (waiting) {
      const index = state.waiting.indexOf(waiting);
      if (index >= 0) state.waiting.splice(index, 1);
      waiting.fail();
    }
    rejectCaller(unavailable());
  };
  const callerDeadline = new Promise<never>((_, reject) => {
    rejectCaller = reject;
    timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
  });
  const native = (async () => {
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        waiting = undefined;
        state.active++;
        resolve();
      };
      if (state.active < state.width) start();
      else {
        waiting = { start, fail: () => reject(unavailable()) };
        state.waiting.push(waiting);
      }
    });
    try {
      return await run(async (text) => {
        if (expired || signal?.aborted || Date.now() >= deadline)
          throw unavailable();
        try {
          return await pool.unsafe(text);
        } catch (error) {
          // PostgresError acknowledges a server error; a definitive closed-connection
          // error proves this client connection is gone. Anything else leaves the backend
          // outcome unknown: quarantine the permit, but only for a bounded time.
          if (!isSettled(error)) uncertain = true;
          throw unavailable();
        }
      });
    } finally {
      if (!uncertain) release(state);
      else {
        const quarantine = setTimeout(
          () => release(state),
          timeoutMs * QUARANTINE_DEADLINES
        );
        quarantine.unref?.();
      }
    }
  })();
  try {
    return await Promise.race([native, callerDeadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}
