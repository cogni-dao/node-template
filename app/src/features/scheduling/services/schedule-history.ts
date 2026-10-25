// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: features/scheduling/services/schedule-history
 * Purpose: Read owned schedules and run metadata with thread correlation.
 * Scope: Orchestrates injected read ports; does not execute runs or mutate threads.
 * Invariants: Schedule ownership on every read; history never loads thread content.
 * Side-effects: IO via injected ports
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
import type { UserId } from "@cogni/ids";
import type { ScheduleHistory } from "@cogni/node-contracts";
import type {
  ScheduleRunReader,
  ScheduleUserPort,
} from "@cogni/scheduler-core";

export class ScheduleHistoryNotFoundError extends Error {}

export function createScheduleHistoryService(deps: {
  schedules: Pick<ScheduleUserPort, "getSchedule">;
  reader: ScheduleRunReader;
}) {
  async function schedule(caller: UserId, scheduleId: string) {
    const found = await deps.schedules.getSchedule(caller, scheduleId);
    if (!found || found.ownerUserId !== caller)
      throw new ScheduleHistoryNotFoundError("Schedule not found");
    return found;
  }
  return {
    schedule,
    async history(
      caller: UserId,
      scheduleId: string,
      options: { limit: number; cursor?: string }
    ): Promise<ScheduleHistory> {
      await schedule(caller, scheduleId);
      const rows = await deps.reader.listRuns(caller, scheduleId, options);
      const page = rows.slice(0, options.limit);
      return {
        runs: page.map((run) => ({
          id: run.id,
          runId: run.runId,
          stateKey: run.stateKey,
          status: run.status,
          scheduledFor: run.scheduledFor?.toISOString() ?? null,
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
        })),
        nextCursor:
          rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
  };
}
