// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/session-admission`
 * Purpose: Admission control for Dolt branch work — bound concurrency ABOVE the connection pool so a burst of writers queues instead of starving the pool.
 * Scope: FIFO queue, cross-replica advisory lock, bounded reserve, and client recreation for session-pinned operations. Does not gate ordinary pooled reads — a write-side proof must never decide whether a read is served (bug.5358).
 * Invariants:
 *   - DOLT_SESSION_ADMISSION: admit one operation BEFORE reserving, never after.
 *     Reserving first is what wedges the pool; see `DoltBranchSessionRunner`.
 *   - Work-item and knowledge writers share one native-base-database domain.
 *     Bridge mode acquires both process-global legacy keys during cutover.
 *   - The runner owns the only `sql.reserve()` call in this package.
 * Side-effects: IO (database connections), time (deadlines + lock retry backoff)
 * Links: docs/spec/knowledge-syntropy.md, packages/knowledge-store/AGENTS.md
 * @public
 */

import {
  acquireDoltWriterLocks,
  DoltWriterAdmissionError,
} from "@cogni-dao/doltgres-admission";
import type { ReservedSql, Sql } from "postgres";

export interface DoltWriteConnection {
  unsafe(
    query: string
  ): Promise<readonly Record<string, unknown>[] & { readonly count?: number }>;
}
export interface DoltBranchWriterGuard {
  readonly baseDatabase: string;
  readonly protocol: "bridge" | "database";
  readonly keys: readonly string[];
  release(): Promise<void>;
}

import { KnowledgeBusyError } from "../../port/knowledge-store.port.js";

/** Historical key retained for bridge compatibility, not an independent writer domain. */
export const KNOWLEDGE_BRANCH_LOCK_KEY = 5_001_002;

/** How long a queued operation waits for its turn before giving up. */
export const QUEUE_WAIT_MS = 30_000;
/**
 * How long to wait for a session-pinned connection once admitted.
 *
 * Covers the priming query AND the reserve: on an exhausted pool the prime is
 * what hangs, so bounding only the reserve bounds nothing.
 */
export const ACQUIRE_TIMEOUT_MS = 5_000;
/** How long to spin for the cross-replica advisory lock. */
export const LOCK_WAIT_MS = 2_000;
/** Gap between advisory-lock attempts. */
export const LOCK_RETRY_MS = 50;

export interface BranchSessionLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const noopLogger: BranchSessionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface BranchSessionOptions {
  readonly logger?: BranchSessionLogger;
  readonly queueWaitMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly lockWaitMs?: number;
  readonly lockRetryMs?: number;
  readonly writerProtocol?: "bridge" | "database";
  readonly queryTimeoutMs?: number;
  /**
   * Rebuilds the client after a wedged session is terminated. Without it a
   * terminated pool cannot be replaced; it stays failed closed until runtime restart.
   */
  readonly recreateClient?: () => Sql;
}

function errorFields(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorMessage: String(error) };
}

/**
 * Serializes Dolt branch operations and hands each one a proven session.
 *
 * WHY ADMISSION CONTROL AND NOT A BIGGER POOL (bug.5391, mirroring the proven
 * `@cogni/work-items` shape):
 *
 * Every Dolt branch operation needs a session-pinned connection, because
 * `dolt_checkout` is session state. postgres.js exposes that as `reserve()`,
 * and a reserved connection is pinned for the WHOLE operation — on Doltgres
 * that is several seconds of `dolt_merge`/`dolt_commit`/`dolt_branch` under
 * load (bug.5395 measured a lease p99 of 4330ms).
 *
 * Two failure modes compound on the shared `max: 5` pool that also serves
 * reads:
 *
 *   - Starvation. Concurrent branch ops hold their reserved connections for
 *     seconds. Once every slot is held, the next caller's query is parked on
 *     postgres.js's UNBOUNDED `queries` backlog with no deadline of its own —
 *     so reads hang right alongside the writes. That is the prod signature:
 *     four `knowledge.contributions.close` calls timing out in the same second
 *     while the list route intermittently stopped answering (bug.5391).
 *   - A cold `reserve()` that never settles. On a `fetch_types: false` client —
 *     mandatory for Doltgres — `ReadyForQuery` skips `fetchArrayTypes()`, so
 *     `onopen` never fires, and `onopen` is the only caller of
 *     `query.reserve(c)`. `connect_timeout` was already cancelled, so nothing
 *     rescues it and the slot is gone for the process lifetime (bug.5386).
 *
 * Priming with a plain query before reserving fixes the second mode. It does
 * nothing for the first, which is why PR #2611 converted an infinite hang into
 * a bounded 15s error without stopping the outage.
 *
 * Raising `max` only defers the wedge and multiplies reserved sessions on a
 * latency-prone substrate. The fix is to bound concurrency ABOVE the pool:
 *
 *   1. FIFO queue — admit ONE operation before it reserves, so a burst queues
 *      instead of racing. Bounded by `queueWaitMs` so a caller fails fast.
 *   2. Prime, then reserve, under ONE deadline covering both. The deadline must
 *      span the prime: on an already-exhausted pool the priming query is itself
 *      parked on the unbounded backlog, so bounding only the reserve still
 *      hangs. Missing the deadline means the pool is wedged: terminate the
 *      client and rebuild it, rather than hand the next caller a pool with one
 *      fewer slot.
 *   3. `pg_try_advisory_lock` — the same one-at-a-time guarantee across
 *      replicas, which an in-process queue cannot give.
 *
 * The pool behind this runner is then deliberately `max: 1`, and it is NOT the
 * pool that serves reads.
 */
export class DoltBranchSessionRunner {
  private sql: Sql;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly logger: BranchSessionLogger;
  private readonly queueWaitMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly lockWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly writerProtocol: "bridge" | "database";
  private readonly queryTimeoutMs: number;
  private readonly retiredPools = new WeakSet<object>();
  private readonly readClients = new WeakSet<object>();
  private readonly connectionPools = new WeakMap<object, Sql>();
  private readonly recreateClient: (() => Sql) | undefined;
  private readonly terminatingPools = new WeakMap<object, Promise<void>>();

  constructor(sql: Sql, options: BranchSessionOptions = {}) {
    this.sql = sql;
    this.logger = options.logger ?? noopLogger;
    this.queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS;
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
    this.writerProtocol = options.writerProtocol ?? "bridge";
    this.queryTimeoutMs = options.queryTimeoutMs ?? 30000;
    this.recreateClient = options.recreateClient;
  }

  /** Register independent readers so current or recreated writer pools cannot alias them. */
  assertIndependentReadClient(reader: Sql): void {
    if (reader === this.sql)
      throw new Error(
        "Knowledge branch writer must use an independent pool from ordinary reads"
      );
    this.readClients.add(reader);
  }

  /** The client currently backing branch work. Swapped on termination. */
  get client(): Sql {
    return this.sql;
  }

  /**
   * Run `fn` on a session-pinned connection, one operation at a time.
   *
   * Throws `KnowledgeBusyError` when admission, reservation, or the advisory
   * lock could not be obtained — in every one of those cases nothing was
   * applied, so the caller may retry.
   */
  async run<T>(
    operation: string,
    fn: (conn: DoltWriteConnection, guard: DoltBranchWriterGuard) => Promise<T>
  ): Promise<T> {
    const leaveQueue = await this.enterQueue(operation);
    try {
      return await this.withSession(operation, fn);
    } finally {
      leaveQueue();
    }
  }

  private log(
    level: "info" | "warn" | "error",
    operation: string,
    stage: string,
    state: "start" | "complete" | "error",
    fields: Record<string, unknown> = {}
  ): void {
    this.logger[level](
      {
        event: "adapter.knowledge.branch_session",
        component: "doltgres-knowledge-store",
        operation,
        stage,
        state,
        ...fields,
      },
      `knowledge ${stage} ${state}`
    );
  }

  /**
   * FIFO admission. Chains onto the previous ticket so operations run in
   * arrival order; a caller that times out still releases its own ticket so the
   * chain cannot deadlock behind an abandoned turn.
   */
  private async enterQueue(operation: string): Promise<() => void> {
    const predecessor = this.operationTail;
    let releaseTurn: () => void = () => undefined;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.operationTail = predecessor.then(() => turnDone);

    const startedAt = Date.now();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        predecessor,
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(
                new KnowledgeBusyError(
                  "Knowledge write queue wait timed out; retry shortly"
                )
              ),
            this.queueWaitMs
          );
        }),
      ]);
    } catch (error) {
      // Keep the FIFO chain live even though this caller abandoned its turn.
      releaseTurn();
      this.log("warn", operation, "queue", "error", {
        durationMs: Date.now() - startedAt,
        reason: "wait_timeout",
      });
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    this.log("info", operation, "queue", "complete", {
      durationMs: Date.now() - startedAt,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTurn();
    };
  }

  /** Retire a session whose mutation or lock acknowledgement is uncertain. */
  async retire(connection: DoltWriteConnection, error: unknown): Promise<void> {
    this.log(
      "error",
      "knowledge.write",
      "session.uncertain",
      "error",
      errorFields(error)
    );
    const pool = this.connectionPools.get(connection);
    if (!pool) throw new Error("Unknown knowledge writer connection");
    await this.terminateClient(
      pool,
      "knowledge.write",
      "session",
      "outcome_uncertain"
    );
  }

  private async restoreMain(
    connection: DoltWriteConnection,
    pool: Sql,
    operation: string
  ): Promise<void> {
    try {
      if ((await connection.unsafe("SELECT * FROM dolt.status")).length)
        throw new Error("Writer left an unproven dirty working set");
      const rows = await connection.unsafe(
        "SELECT active_branch() AS branch_name"
      );
      const active = rows[0]?.branch_name;
      if (active !== "main") {
        await connection.unsafe("SELECT dolt_checkout('main')");
        const proof = await connection.unsafe(
          "SELECT active_branch() AS branch_name"
        );
        if (
          proof[0]?.branch_name !== "main" ||
          (await connection.unsafe("SELECT * FROM dolt.status")).length
        )
          throw new Error("Clean main restoration was not proven");
      }
    } catch {
      await this.terminateClient(
        pool,
        operation,
        "checkout",
        "restore_uncertain"
      );
    }
  }

  private async withSession<T>(
    operation: string,
    fn: (conn: DoltWriteConnection, guard: DoltBranchWriterGuard) => Promise<T>
  ): Promise<T> {
    const pool = this.sql;
    let native: ReservedSql | undefined;
    let guard: DoltBranchWriterGuard | undefined;
    let connection: DoltWriteConnection | undefined;
    try {
      native = await this.acquireSession(pool, operation);
      const reserved = native;
      connection = {
        unsafe: async (query: string) => {
          if (this.retiredPools.has(pool))
            throw new KnowledgeBusyError(
              "Knowledge writer session was retired"
            );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              reserved.unsafe(query),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new KnowledgeBusyError("Knowledge SQL deadline exceeded")
                    ),
                  this.queryTimeoutMs
                );
              }),
            ]);
          } catch (error) {
            if (error instanceof KnowledgeBusyError)
              await this.terminateClient(
                pool,
                operation,
                "query",
                "query_timeout"
              );
            throw error;
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
      };
      this.connectionPools.set(connection, pool);
      try {
        guard = await acquireDoltWriterLocks(connection, {
          protocol: this.writerProtocol,
          lockWaitMs: this.lockWaitMs,
          lockRetryMs: this.lockRetryMs,
        });
      } catch (error) {
        if (error instanceof DoltWriterAdmissionError && error.discardSession)
          await this.terminateClient(
            pool,
            operation,
            "lock.acquire",
            error.reason
          );
        throw new KnowledgeBusyError(
          "Knowledge writer admission unavailable; retry before starting a mutation"
        );
      }
      return await fn(connection, guard);
    } finally {
      if (guard && connection && !this.retiredPools.has(pool))
        await this.restoreMain(connection, pool, operation);
      if (guard && !this.retiredPools.has(pool)) {
        try {
          await guard.release();
        } catch (error) {
          this.log(
            "error",
            operation,
            "lock.release",
            "error",
            errorFields(error)
          );
          await this.terminateClient(
            pool,
            operation,
            "lock.release",
            "unlock_uncertain"
          );
        }
      }
      if (native && !this.retiredPools.has(pool)) native.release();
    }
  }

  /**
   * Prime, then reserve, under a single deadline.
   *
   * PRIME_BEFORE_RESERVE: an ordinary query reaches postgres.js `onopen`, which
   * a cold `reserve()` does not. The deadline spans the prime because on an
   * exhausted pool the prime is what parks. Missing it means the client is
   * wedged, so it is condemned and rebuilt rather than handed on.
   */
  private async acquireSession(
    pool: Sql,
    operation: string
  ): Promise<ReservedSql> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new KnowledgeBusyError(
              `Knowledge write plane timed out after ${this.acquireTimeoutMs}ms acquiring a session-pinned connection; retry shortly`
            )
          ),
        this.acquireTimeoutMs
      );
    });

    const acquire = (async () => {
      await pool.unsafe("SELECT 1 AS knowledge_ready");
      return await pool.reserve();
    })();

    try {
      return await Promise.race([acquire, expiry]);
    } catch (error) {
      // The losing acquire may still settle; hand its slot straight back so a
      // timed-out call cannot leak one on top of the failure.
      void acquire.then(
        (late) => late.release(),
        () => undefined
      );
      await this.terminateClient(pool, operation, "acquire", "acquire_timeout");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * End a wedged client and rebuild it, so the next caller gets a whole pool
   * rather than one with a permanently burnt slot. Without a factory the pool
   * remains retired; unknown native lock/session state is never reused.
   */
  private async terminateClient(
    pool: Sql,
    operation: string,
    stage: string,
    reason: string
  ): Promise<void> {
    const active = this.terminatingPools.get(pool as object);
    if (active) return active;

    this.retiredPools.add(pool);
    const termination = (async () => {
      this.log("error", operation, "connection.terminate", "error", {
        failedStage: stage,
        reason,
      });
      try {
        await pool.end({ timeout: 0 });
      } catch (error) {
        this.log("error", operation, "connection.terminate", "error", {
          failedStage: stage,
          reason: "terminate_failed",
          ...errorFields(error),
        });
        return;
      }
      if (this.sql !== pool || !this.recreateClient) return;
      try {
        const replacement = this.recreateClient();
        if (
          !replacement ||
          this.readClients.has(replacement) ||
          this.retiredPools.has(replacement)
        )
          throw new Error(
            "Knowledge writer factory must return a fresh independent writer pool"
          );
        this.sql = replacement;
        this.log("info", operation, "connection.recreate", "complete", {
          failedStage: stage,
        });
      } catch (error) {
        this.log("error", operation, "connection.recreate", "error", {
          failedStage: stage,
          ...errorFields(error),
        });
      }
    })();
    this.terminatingPools.set(pool as object, termination);
    return termination;
  }
}
