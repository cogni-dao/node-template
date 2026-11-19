// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/knowledge-usage/knowledge-read-counter.adapter`
 * Purpose: Batched write-time counters for agent atom reads in `knowledge_read_daily` (story.0061).
 * Scope: `count()` adds 1 to an in-memory map keyed by (day, atom, principal); one multi-row upsert flushes it every
 *   60 s and on shutdown.
 * Invariants:
 * - KEYS_NOT_TRAFFIC: rows and write statements grow with distinct keys and flush intervals, never with read volume.
 * - NEVER_BLOCKS: `count()` is synchronous and never throws; a write failure never reaches the caller.
 * - ONE_FLUSH_IN_FLIGHT: at most one upsert holds a service-pool connection at a time.
 * - SORTED_UPSERT: rows are written in key order, so concurrent pods lock rows in the same order and cannot deadlock.
 * - BOUNDED_MAP: at most 5,000 pending keys; a read for a new key past that is dropped and counted.
 * - BOUNDED_MISSES: a missed id is caller-chosen, so an id outside CITE_ID_PATTERN counts as `*invalid*`, and past 100
 *   distinct missed ids per (day, principal) in this process the rest count as `*overflow*`.
 * - LOWER_BOUND: a failed flush is merged back for the next one; only reads past the key cap are lost, and every
 *   flush and every loss is one log line.
 * Side-effects: IO (Postgres upsert via the service role, structured logs)
 * Links: https://node-template.cognidao.org/knowledge/knowledge-usage-telemetry
 * @internal
 */

import { randomUUID } from "node:crypto";

import type { Database } from "@cogni/db-client";
import { knowledgeReadDaily } from "@cogni/db-schema";
import { CITE_ID_PATTERN } from "@cogni/work-items";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";

import type { KnowledgeRead, KnowledgeReadCounter } from "@/ports";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const READ_COUNT_FLUSH_INTERVAL_MS = 60_000;
export const READ_COUNT_MAX_KEYS = 5_000;
export const MISSED_IDS_PER_PRINCIPAL_DAY = 100;
export const INVALID_ATOM_KEY = "*invalid*";
export const OVERFLOW_ATOM_KEY = "*overflow*";
const FLUSH_STATEMENT_TIMEOUT = "2s";

type Row = typeof knowledgeReadDaily.$inferInsert & {
  okCount: number;
  failCount: number;
};

export class PostgresKnowledgeReadCounter implements KnowledgeReadCounter {
  private pending = new Map<string, Row>();
  /** Distinct missed ids per `${day}\u0000${principal}` in this process; reset when the day changes. */
  private missed = new Map<string, Set<string>>();
  private missedDay = "";
  private flushing = false;
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Database,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  count(read: KnowledgeRead): void {
    try {
      const day = this.now().toISOString().slice(0, 10);
      const atomId = read.outcome === "ok" ? read.atomId : this.missKey(day, read);
      const key = `${day}\u0000${atomId}\u0000${read.principalId}\u0000${read.principalClass}`;
      let row = this.pending.get(key);
      if (!row) {
        if (this.pending.size >= READ_COUNT_MAX_KEYS) {
          this.dropped += 1;
          return;
        }
        row = {
          day,
          atomId,
          principalId: read.principalId,
          principalClass: read.principalClass,
          okCount: 0,
          failCount: 0,
        };
        this.pending.set(key, row);
      }
      if (read.outcome === "ok") row.okCount += 1;
      else row.failCount += 1;
      this.ensureTimer();
    } catch {
      // NEVER_BLOCKS: counting must not affect the caller.
    }
  }

  /** Upserts the pending counts in one statement. Called by the timer and on shutdown; safe to call concurrently. */
  async flush(): Promise<void> {
    this.reportDropped();
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    const rows = [...this.pending.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, row]) => row);
    this.pending = new Map();
    const reads = rows.reduce((sum, r) => sum + r.okCount + r.failCount, 0);
    // Reads by class and outcome: the flush log's only breakdown, so a candidate probe can be checked without a DB read.
    const byClass: Record<string, { ok: number; fail: number }> = {};
    for (const r of rows) {
      const c = (byClass[r.principalClass] ??= { ok: 0, fail: 0 });
      c.ok += r.okCount;
      c.fail += r.failCount;
    }
    const reqId = `read-count-flush-${randomUUID()}`;
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(`SET LOCAL statement_timeout = '${FLUSH_STATEMENT_TIMEOUT}'`),
        );
        await tx
          .insert(knowledgeReadDaily)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              knowledgeReadDaily.day,
              knowledgeReadDaily.atomId,
              knowledgeReadDaily.principalId,
              knowledgeReadDaily.principalClass,
            ],
            set: {
              okCount: sql`${knowledgeReadDaily.okCount} + excluded.ok_count`,
              failCount: sql`${knowledgeReadDaily.failCount} + excluded.fail_count`,
              updatedAt: sql`now()`,
            },
          });
      });
      logEvent(this.log, EVENT_NAMES.KNOWLEDGE_READ_COUNTS_FLUSHED, {
        reqId,
        keys: rows.length,
        reads,
        byClass,
      });
    } catch (error) {
      this.restore(rows);
      logEvent(this.log, EVENT_NAMES.KNOWLEDGE_READ_COUNT_WRITE_FAILED, {
        reqId,
        reason: "flush_failed",
        keys: rows.length,
        reads,
        errorClass: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      this.flushing = false;
    }
  }

  /** The key a missed read counts under: its own id, or a sentinel once the id is invalid or past the per-day cap. */
  private missKey(day: string, read: KnowledgeRead): string {
    if (!CITE_ID_PATTERN.test(read.atomId)) return INVALID_ATOM_KEY;
    if (day !== this.missedDay) {
      this.missed = new Map();
      this.missedDay = day;
    }
    const scope = `${day}\u0000${read.principalId}`;
    let ids = this.missed.get(scope);
    if (!ids) {
      ids = new Set();
      this.missed.set(scope, ids);
    }
    if (ids.has(read.atomId)) return read.atomId;
    if (ids.size >= MISSED_IDS_PER_PRINCIPAL_DAY) return OVERFLOW_ATOM_KEY;
    ids.add(read.atomId);
    return read.atomId;
  }

  /** A failed flush puts its counts back, so a lost ok cannot turn into a false miss. Past the key cap they are dropped. */
  private restore(rows: readonly Row[]): void {
    for (const row of rows) {
      const key = `${row.day}\u0000${row.atomId}\u0000${row.principalId}\u0000${row.principalClass}`;
      const current = this.pending.get(key);
      if (current) {
        current.okCount += row.okCount;
        current.failCount += row.failCount;
      } else if (this.pending.size < READ_COUNT_MAX_KEYS) {
        this.pending.set(key, { ...row });
      } else {
        this.dropped += row.okCount + row.failCount;
      }
    }
  }

  private reportDropped(): void {
    if (this.dropped === 0) return;
    const reads = this.dropped;
    this.dropped = 0;
    logEvent(this.log, EVENT_NAMES.KNOWLEDGE_READ_COUNT_WRITE_FAILED, {
      reqId: `read-count-flush-${randomUUID()}`,
      reason: "map_full",
      reads,
    });
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, READ_COUNT_FLUSH_INTERVAL_MS);
    // The counter never keeps the process alive.
    this.timer.unref?.();
  }
}
