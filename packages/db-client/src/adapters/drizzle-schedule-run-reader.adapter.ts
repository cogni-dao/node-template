// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: db-client/drizzle-schedule-run-reader
 * Purpose: Read schedule-owned run history using the application database role.
 * Scope: Metadata reads only; does not read output or control execution.
 * Invariants: RLS plus explicit schedule owner; seek uses raw database precision.
 * Side-effects: IO (database reads)
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
import { graphRuns, schedules } from "@cogni/db-schema/scheduling";
import { type UserId, userActor } from "@cogni/ids";
import {
  InvalidScheduleRunCursorError,
  type ScheduleRunReader,
} from "@cogni/scheduler-core";
import { and, desc, eq, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { Database } from "../client";
import { withTenantScope } from "../tenant-scope";

export class DrizzleScheduleRunReader implements ScheduleRunReader {
  constructor(private readonly db: Database) {}

  async listRuns(
    caller: UserId,
    scheduleId: string,
    options: { limit: number; cursor?: string }
  ) {
    return withTenantScope(this.db, userActor(caller), async (tx) => {
      const ownership = and(
        eq(schedules.ownerUserId, caller),
        eq(graphRuns.scheduleId, scheduleId)
      );
      let seek: SQL | undefined;
      if (options.cursor) {
        const [anchor] = await tx
          .select({
            id: graphRuns.id,
            // Cast to text inside PostgreSQL: a JS Date would discard microseconds.
            slot: sql<string | null>`${graphRuns.scheduledFor}::text`,
          })
          .from(graphRuns)
          .innerJoin(schedules, eq(schedules.id, graphRuns.scheduleId))
          .where(and(ownership, eq(graphRuns.id, options.cursor)))
          .limit(1);
        if (!anchor) throw new InvalidScheduleRunCursorError();
        seek =
          anchor.slot === null
            ? and(isNull(graphRuns.scheduledFor), lt(graphRuns.id, anchor.id))
            : or(
                sql`${graphRuns.scheduledFor} < ${anchor.slot}::timestamptz`,
                and(
                  sql`${graphRuns.scheduledFor} = ${anchor.slot}::timestamptz`,
                  lt(graphRuns.id, anchor.id)
                ),
                isNull(graphRuns.scheduledFor)
              );
      }
      const rows = await tx
        .select({ run: graphRuns })
        .from(graphRuns)
        .innerJoin(schedules, eq(schedules.id, graphRuns.scheduleId))
        .where(and(ownership, seek))
        .orderBy(
          sql`${graphRuns.scheduledFor} DESC NULLS LAST`,
          desc(graphRuns.id)
        )
        .limit(Math.min(Math.max(options.limit, 1), 50) + 1);
      return rows.map(({ run }) => run);
    });
  }
}
