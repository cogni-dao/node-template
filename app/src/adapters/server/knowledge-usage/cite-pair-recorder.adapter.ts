// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/knowledge-usage/cite-pair-recorder.adapter`
 * Purpose: Record each (atom, work item) pair a successful work-item patch cites, once, in `knowledge_cite_pairs`
 *   (story.0061), so heavily read atoms can be checked against the outcomes of the items that used them.
 * Scope: One fire-and-forget insert of at most 8 rows per citing patch, `ON CONFLICT DO NOTHING`.
 * Invariants:
 * - PAIRS_NOT_PATCHES: rows grow with distinct pairs; a repeat cite of the same atom on the same item writes nothing.
 * - NEVER_FAILS_THE_PATCH: `record()` is synchronous and never throws; the Doltgres commit already happened.
 * - BOUNDED_IN_FLIGHT: at most 4 inserts in flight, each with a 2 s statement timeout; a pair past that is dropped
 *   and logged.
 * Side-effects: IO (Postgres insert via the service role, structured logs)
 * Links: https://node-template.cognidao.org/knowledge/knowledge-read-correctness
 * @internal
 */

import { randomUUID } from "node:crypto";

import type { Database } from "@cogni/db-client";
import { knowledgeCitePairs } from "@cogni/db-schema";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";

import { EVENT_NAMES, logEvent } from "@/shared/observability";

const MAX_IN_FLIGHT = 4;

export class PostgresCitePairRecorder {
  private inFlight = 0;

  constructor(
    private readonly db: Database,
    private readonly log: Logger,
  ) {}

  /** `revision` is the item revision the patch produced; a non-integer revision records nothing. */
  record(workItemId: string, revision: string | number, atomIds: readonly string[]): void {
    try {
      const firstItemRevision = Number(revision);
      const ids = [...new Set(atomIds)].sort();
      if (!Number.isInteger(firstItemRevision) || ids.length === 0) return;
      if (this.inFlight >= MAX_IN_FLIGHT) {
        this.fail("in_flight_cap", ids.length);
        return;
      }
      this.inFlight += 1;
      void this.db
        .transaction(async (tx) => {
          await tx.execute(sql.raw("SET LOCAL statement_timeout = '2s'"));
          await tx
            .insert(knowledgeCitePairs)
            .values(ids.map((atomId) => ({ atomId, workItemId, firstItemRevision })))
            .onConflictDoNothing();
        })
        .catch((error: unknown) => this.fail("insert_failed", ids.length, error))
        .finally(() => {
          this.inFlight -= 1;
        });
    } catch {
      // NEVER_FAILS_THE_PATCH
    }
  }

  private fail(reason: string, pairs: number, error?: unknown): void {
    logEvent(this.log, EVENT_NAMES.KNOWLEDGE_CITE_PAIRS_WRITE_FAILED, {
      reqId: `cite-pairs-${randomUUID()}`,
      reason,
      pairs,
      ...(error ? { errorClass: error instanceof Error ? error.name : typeof error } : {}),
    });
  }
}
