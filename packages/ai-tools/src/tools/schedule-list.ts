// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/schedule-list`
 * Purpose: AI tool that lists all schedules for the current user.
 * Scope: Read-only schedule listing. Does not mutate schedules or import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__schedule_list`
 *   - EFFECT_TYPED: effect is `read_only`
 * Side-effects: IO (reads schedules via capability)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/scheduler.md
 * @public
 */

import { z } from "zod";

import type { ScheduleCapability } from "../capabilities/schedule";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const ScheduleListInputSchema = z.object({
  purpose: z.string().min(1).max(200).optional()
    .describe("Exact input._meta.purpose to match; excludes coordinating jobs that only mention this purpose in messages"),
}).strict();
export type ScheduleListInput = z.infer<typeof ScheduleListInputSchema>;

const ScheduleItemSchema = z.object({
  id: z.string(),
  graphId: z.string(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  input: z.record(z.string(), z.unknown()),
});

export const ScheduleListOutputSchema = z.object({
  schedules: z.array(ScheduleItemSchema),
  count: z.number(),
});
export type ScheduleListOutput = z.infer<typeof ScheduleListOutputSchema>;

export type ScheduleListRedacted = ScheduleListOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEDULE_LIST_NAME = "core__schedule_list" as const;

export const scheduleListContract: ToolContract<
  typeof SCHEDULE_LIST_NAME,
  ScheduleListInput,
  ScheduleListOutput,
  ScheduleListRedacted
> = {
  name: SCHEDULE_LIST_NAME,
  description:
    "List all scheduled graph executions. Returns schedule IDs, graph assignments, " +
    "cron expressions, timezones, and enabled/disabled status. Use this to see " +
    "what is currently scheduled before making changes. Supply purpose for an exact metadata match.",
  effect: "read_only",
  inputSchema: ScheduleListInputSchema,
  outputSchema: ScheduleListOutputSchema,

  redact: (output: ScheduleListOutput): ScheduleListRedacted => output,
  allowlist: ["schedules", "count"] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleListDeps {
  readonly scheduleCapability: ScheduleCapability;
}

export function createScheduleListImplementation(
  deps: ScheduleListDeps
): ToolImplementation<ScheduleListInput, ScheduleListOutput> {
  return {
    execute: async ({ purpose }): Promise<ScheduleListOutput> => {
      const owned = await deps.scheduleCapability.list();
      const schedules = purpose === undefined ? owned : owned.filter((s) => {
        const meta = s.input._meta;
        return typeof meta === "object" && meta !== null && "purpose" in meta && meta.purpose === purpose;
      });
      return {
        schedules: schedules.map((s) => ({
          id: s.id,
          graphId: s.graphId,
          cron: s.cron,
          timezone: s.timezone,
          enabled: s.enabled,
          nextRunAt: s.nextRunAt,
          lastRunAt: s.lastRunAt,
          input: s.input,
        })),
        count: schedules.length,
      };
    },
  };
}

export const scheduleListStubImplementation: ToolImplementation<
  ScheduleListInput,
  ScheduleListOutput
> = {
  execute: async (): Promise<ScheduleListOutput> => {
    throw new Error("ScheduleCapability not configured.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool
// ─────────────────────────────────────────────────────────────────────────────

export const scheduleListBoundTool: BoundTool<
  typeof SCHEDULE_LIST_NAME,
  ScheduleListInput,
  ScheduleListOutput,
  ScheduleListRedacted
> = {
  contract: scheduleListContract,
  implementation: scheduleListStubImplementation,
};
