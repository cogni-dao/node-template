// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/schedule-manage`
 * Purpose: AI tool for creating, updating, deleting, and toggling schedules.
 * Scope: Flat-object schedule mutations via ScheduleCapability. Does not import LangChain or app-domain types.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__schedule_manage`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - EDIT_POLICY_ENFORCED: Rejects mutations on schedules with editPolicy=human_only
 *   - NO_ONEOF_IN_SCHEMA: Uses flat z.object (not discriminatedUnion) per tool-use.md #10
 * Side-effects: IO (creates/updates/deletes schedules via capability)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/scheduler.md, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/tool-use.md
 * @public
 */

import { z } from "zod";

import type { ScheduleCapability } from "../capabilities/schedule";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flat object schema for schedule management.
 *
 * Per tool-use.md #10: inputSchema must compile to JSON Schema `type: "object"`.
 * z.discriminatedUnion produces `oneOf` which OpenAI rejects.
 * Instead: action enum + all fields optional; implementation validates per-action.
 */
export const ScheduleManageInputSchema = z.object({
  action: z
    .enum(["create", "update", "delete", "enable", "disable"])
    .describe("Action to perform on the schedule"),
  graphId: z
    .string()
    .min(1)
    .optional()
    .describe("Graph ID (required for create, e.g., 'langgraph:work-prioritizer')"),
  scheduleId: z
    .string()
    .min(1)
    .optional()
    .describe("Schedule ID (required for update/delete/enable/disable)"),
  cron: z
    .string()
    .min(1)
    .optional()
    .describe(
      "5-field cron expression (required for create, e.g., '0 15 * * *' for 3pm daily)"
    ),
  timezone: z
    .string()
    .min(1)
    .optional()
    .describe(
      "IANA timezone (required for create, e.g., 'UTC', 'America/New_York')"
    ),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Graph input payload; create requires messages and a stable _meta.purpose"),
  instruction: z.string().min(1).optional()
    .describe("Task for the scheduled workflow; prefer this to constructing message history. The host creates its user message."),
  purpose: z.string().min(1).max(200).optional()
    .describe("Stable job purpose for create; stored as input._meta.purpose"),
});
export type ScheduleManageInput = z.infer<typeof ScheduleManageInputSchema>;

export const ScheduleManageOutputSchema = z.object({
  success: z.boolean(),
  action: z.string(),
  scheduleId: z.string().optional(),
  message: z.string(),
});
export type ScheduleManageOutput = z.infer<typeof ScheduleManageOutputSchema>;

export type ScheduleManageRedacted = ScheduleManageOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEDULE_MANAGE_NAME = "core__schedule_manage" as const;

export const scheduleManageContract: ToolContract<
  typeof SCHEDULE_MANAGE_NAME,
  ScheduleManageInput,
  ScheduleManageOutput,
  ScheduleManageRedacted
> = {
  name: SCHEDULE_MANAGE_NAME,
  description:
    "Manage scheduled graph executions. Actions: " +
    "'create' (requires graphId + cron + timezone + input), " +
    "'update' (requires scheduleId, optional cron/timezone/input), " +
    "'delete' (requires scheduleId), " +
    "'enable'/'disable' (requires scheduleId). " +
    "Use core__schedule_list first to see existing schedules.",
  effect: "state_change",
  requires: {
    scope: "schedule:manage",
    kind: "own",
    subject: "member",
    label: "Create and change schedules for the person it helps",
    description: "Make, change and stop schedules for the person it helps.",
  },
  inputSchema: ScheduleManageInputSchema,
  outputSchema: ScheduleManageOutputSchema,

  redact: (output: ScheduleManageOutput): ScheduleManageRedacted => output,
  allowlist: ["success", "action", "scheduleId", "message"] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleManageDeps {
  readonly scheduleCapability: ScheduleCapability;
}

/**
 * Check editPolicy before mutating a schedule.
 * Rejects if the schedule's input._meta.editPolicy is "human_only".
 */
async function checkEditPolicy(
  capability: ScheduleCapability,
  scheduleId: string
): Promise<void> {
  const schedules = await capability.list();
  const target = schedules.find((s) => s.id === scheduleId);
  if (!target) return; // Let the actual operation handle not-found
  const meta = target.input._meta as { editPolicy?: string } | undefined;
  if (meta?.editPolicy === "human_only") {
    throw new Error(
      `Schedule ${scheduleId} has editPolicy=human_only and cannot be modified by AI tools.`
    );
  }
}

function requireField<T>(
  value: T | undefined,
  fieldName: string,
  action: string
): T {
  if (value === undefined) {
    throw new Error(`${fieldName} is required for action '${action}'`);
  }
  return value;
}

export function createScheduleManageImplementation(
  deps: ScheduleManageDeps
): ToolImplementation<ScheduleManageInput, ScheduleManageOutput> {
  const { scheduleCapability } = deps;

  return {
    execute: async (
      input: ScheduleManageInput
    ): Promise<ScheduleManageOutput> => {
      if (input.action !== "create" &&
          (input.instruction !== undefined || input.purpose !== undefined || input.graphId !== undefined)) {
        throw new Error("graphId, instruction and purpose are create-only fields; configuration changes require a supported update path.");
      }
      switch (input.action) {
        case "create": {
          const graphId = requireField(input.graphId, "graphId", "create");
          const cron = requireField(input.cron, "cron", "create");
          const timezone = requireField(input.timezone, "timezone", "create");
          const payload = { ...input.input };
          if (input.instruction !== undefined) {
            payload.messages = [{ role: "user", content: input.instruction }];
          } else if (!Array.isArray(payload.messages)) {
            throw new Error("instruction is required for action 'create': the task the scheduled workflow runs on each tick.");
          }
          if (input.purpose !== undefined) {
            const meta = payload._meta;
            payload._meta = {
              ...(typeof meta === "object" && meta !== null && !Array.isArray(meta) ? meta : {}),
              purpose: input.purpose,
            };
          }
          const result = await scheduleCapability.create({
            graphId,
            cron,
            timezone,
            input: payload,
          });
          return {
            success: true,
            action: "create",
            scheduleId: result.id,
            message: `Schedule for ${graphId} uses cron '${cron}'`,
          };
        }
        case "update": {
          if (input.cron === undefined && input.timezone === undefined && input.input === undefined) {
            throw new Error("update requires a configuration change; use enable or disable to toggle a schedule.");
          }
          const scheduleId = requireField(
            input.scheduleId,
            "scheduleId",
            "update"
          );
          await checkEditPolicy(scheduleCapability, scheduleId);
          const result = await scheduleCapability.update(scheduleId, {
            ...(input.cron !== undefined && { cron: input.cron }),
            ...(input.timezone !== undefined && { timezone: input.timezone }),
            ...(input.input !== undefined && { input: input.input }),
          });
          return {
            success: true,
            action: "update",
            scheduleId: result.id,
            message: `Updated schedule ${scheduleId}`,
          };
        }
        case "delete": {
          const scheduleId = requireField(
            input.scheduleId,
            "scheduleId",
            "delete"
          );
          await checkEditPolicy(scheduleCapability, scheduleId);
          await scheduleCapability.remove(scheduleId);
          return {
            success: true,
            action: "delete",
            scheduleId,
            message: `Deleted schedule ${scheduleId}`,
          };
        }
        case "enable": {
          const scheduleId = requireField(
            input.scheduleId,
            "scheduleId",
            "enable"
          );
          await checkEditPolicy(scheduleCapability, scheduleId);
          const result = await scheduleCapability.setEnabled(scheduleId, true);
          return {
            success: true,
            action: "enable",
            scheduleId: result.id,
            message: `Enabled schedule ${scheduleId}`,
          };
        }
        case "disable": {
          const scheduleId = requireField(
            input.scheduleId,
            "scheduleId",
            "disable"
          );
          await checkEditPolicy(scheduleCapability, scheduleId);
          const result = await scheduleCapability.setEnabled(scheduleId, false);
          return {
            success: true,
            action: "disable",
            scheduleId: result.id,
            message: `Disabled schedule ${scheduleId}`,
          };
        }
      }
    },
  };
}

export const scheduleManageStubImplementation: ToolImplementation<
  ScheduleManageInput,
  ScheduleManageOutput
> = {
  execute: async (): Promise<ScheduleManageOutput> => {
    throw new Error("ScheduleCapability not configured.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool
// ─────────────────────────────────────────────────────────────────────────────

export const scheduleManageBoundTool: BoundTool<
  typeof SCHEDULE_MANAGE_NAME,
  ScheduleManageInput,
  ScheduleManageOutput,
  ScheduleManageRedacted
> = {
  contract: scheduleManageContract,
  implementation: scheduleManageStubImplementation,
};
