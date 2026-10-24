// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: features/scheduling/services/schedule-history
 * Purpose: Read owned schedules, run metadata and exact saved assistant responses.
 * Scope: Orchestrates injected read ports; does not execute runs or mutate threads.
 * Invariants: Schedule ownership on every read; exact assistant ID and caller-owned thread.
 * Side-effects: IO via injected ports
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
import type { UserId } from "@cogni/ids";
import type {
  ScheduleHistory,
  ScheduleSavedOutput,
} from "@cogni/node-contracts";
import type {
  ScheduleRunReader,
  ScheduleUserPort,
} from "@cogni/scheduler-core";
import type { ThreadPersistencePort } from "@/ports";

export class ScheduleHistoryNotFoundError extends Error {}

export function createScheduleHistoryService(deps: {
  schedules: Pick<ScheduleUserPort, "getSchedule">;
  reader: ScheduleRunReader;
  threadPersistenceForUser: (
    user: UserId
  ) => Pick<ThreadPersistencePort, "loadThread">;
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
          status: run.status,
          scheduledFor: run.scheduledFor?.toISOString() ?? null,
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
        })),
        nextCursor:
          rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
    async output(
      caller: UserId,
      scheduleId: string,
      runId: string
    ): Promise<ScheduleSavedOutput> {
      await schedule(caller, scheduleId);
      const run = await deps.reader.getRun(caller, scheduleId, runId);
      if (!run || run.scheduleId !== scheduleId || run.runId !== runId)
        throw new ScheduleHistoryNotFoundError("Run not found");
      if (!run.stateKey) return { availability: "unavailable", text: null };
      const messages = await deps
        .threadPersistenceForUser(caller)
        .loadThread(caller, run.stateKey);
      const message = messages.find(
        (item) => item.id === `assistant-${runId}` && item.role === "assistant"
      );
      if (!message) return { availability: "unavailable", text: null };
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n");
      return text.length > 0
        ? { availability: "available", text }
        : { availability: "empty", text: "" };
    },
  };
}
