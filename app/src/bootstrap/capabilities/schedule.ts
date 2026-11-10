// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/schedule`
 * Purpose: Factory for ScheduleCapability — bridges ai-tools interface to ScheduleUserPort with RLS-scoped user identity.
 * Scope: Creates ScheduleCapability that reads the subject (else principal) user id from ExecutionScope (ALS) at invocation time. Does not implement transport.
 * Invariants:
 *   - RLS_ENFORCED: All schedule operations use the real user's identity, never system principal
 *   - CRUD_IS_TEMPORAL_AUTHORITY: All mutations go through ScheduleUserPort → Temporal
 * Side-effects: none (factory only)
 * Links: docs/spec/scheduler.md
 * @internal
 */

import { isDeepStrictEqual } from "node:util";
import type {
  ScheduleCapability,
  ScheduleCreateParams,
  ScheduleInfo,
  ScheduleUpdateParams,
} from "@cogni/ai-tools";
import type { UserId } from "@cogni/ids";
import { toUserId } from "@cogni/ids";
import { NODE_LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import { chatCompletionsContract } from "@cogni/node-contracts";
import type { ScheduleUserPort } from "@cogni/scheduler-core";
import { z } from "zod";

import { getExecutionScope, scopeUserId } from "@/adapters/server";
import { getNodeId } from "@/shared/config";

/**
 * Dependencies for creating the schedule capability.
 */
export interface ScheduleCapabilityDeps {
  readonly scheduleManager: ScheduleUserPort;
  readonly getOrCreateBillingAccountId: (userId: UserId) => Promise<string>;
}

/**
 * Resolve the user id schedule operations run as from ExecutionScope (ALS): the subject, else the principal.
 * Throws if no execution scope or no identity — tools must run within a graph execution.
 */
function resolveUserId(): UserId {
  const userId = scopeUserId(getExecutionScope());
  if (!userId) {
    throw new Error(
      "ScheduleCapability: no subject or principal in ExecutionScope. " +
        "Schedule tools must run within an authenticated graph execution."
    );
  }
  return toUserId(userId);
}

function toScheduleInfo(spec: {
  id: string;
  graphId: string;
  input: unknown;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ScheduleInfo {
  return {
    id: spec.id,
    graphId: spec.graphId,
    input: spec.input as Record<string, unknown>,
    cron: spec.cron,
    timezone: spec.timezone,
    enabled: spec.enabled,
    nextRunAt: spec.nextRunAt?.toISOString() ?? null,
    lastRunAt: spec.lastRunAt?.toISOString() ?? null,
    createdAt: spec.createdAt.toISOString(),
    updatedAt: spec.updatedAt.toISOString(),
  };
}

/** Accept listed internal histories and OpenAI wire histories without losing tool calls. */
function toWireMessage(value: unknown): unknown {
  const message = z.record(z.string(), z.unknown()).parse(value);
  const { toolCalls, toolCallId, ...wire } = message;
  if (Object.hasOwn(message, "toolCalls")) {
    if (message.role !== "assistant" || Object.hasOwn(message, "tool_calls")) {
      throw new Error("ScheduleCapability: ambiguous or misplaced toolCalls");
    }
    wire.tool_calls = Array.isArray(toolCalls)
      ? toolCalls.map((value) => {
          const call = z.record(z.string(), z.unknown()).parse(value);
          return {
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          };
        })
      : toolCalls;
  }
  if (Object.hasOwn(message, "toolCallId")) {
    if (message.role !== "tool" || Object.hasOwn(message, "tool_call_id")) {
      throw new Error("ScheduleCapability: ambiguous or misplaced toolCallId");
    }
    wire.tool_call_id = toolCallId;
  }
  return wire;
}

/**
 * Create a ScheduleCapability that resolves user identity from ALS at call time.
 *
 * This ensures RLS is always enforced — the capability operates as the real user,
 * not a system principal.
 */
export function createScheduleCapability(
  deps: ScheduleCapabilityDeps,
): ScheduleCapability {
  const { scheduleManager, getOrCreateBillingAccountId } = deps;

  return {
    async list(): Promise<readonly ScheduleInfo[]> {
      const userId = resolveUserId();
      const schedules = await scheduleManager.listSchedules(userId);
      return schedules.map(toScheduleInfo);
    },

    async create(input: ScheduleCreateParams): Promise<ScheduleInfo> {
      const userId = resolveUserId();
      const graphName = input.graphId.startsWith("langgraph:")
        ? input.graphId.slice("langgraph:".length)
        : "";
      if (!Object.hasOwn(NODE_LANGGRAPH_CATALOG, graphName)) {
        throw new Error(
          "ScheduleCapability: workflow is not registered on this node",
        );
      }
      const messages = z
        .array(
          z.preprocess(
            toWireMessage,
            chatCompletionsContract.input.shape.messages.element,
          ),
        )
        .min(1)
        .parse(input.input.messages)
        .map((message) => {
          // Scheduled graph execution consumes internal message DTOs.
          if (message.role === "tool") {
            return {
              role: message.role,
              content: message.content,
              toolCallId: message.tool_call_id,
            };
          }
          if (message.role === "assistant") {
            return {
              role: message.role,
              content: message.content ?? "",
              ...(message.tool_calls?.length
                ? {
                    toolCalls: message.tool_calls.map((call) => ({
                      id: call.id,
                      name: call.function.name,
                      arguments: call.function.arguments,
                    })),
                  }
                : {}),
            };
          }
          return { role: message.role, content: message.content };
        });
      const modelRef = getExecutionScope().modelRef;
      if (!modelRef) {
        throw new Error(
          "ScheduleCapability: host model reference is unavailable",
        );
      }
      const { purpose } = z
        .object({ purpose: z.string().min(1).max(200) })
        .parse(input.input._meta);
      const boundInput = { ...input.input, messages, modelRef };
      const matches = (await scheduleManager.listSchedules(userId)).filter(
        (s) => {
          const meta = (s.input as Record<string, unknown>)?._meta;
          return (
            typeof meta === "object" &&
            meta !== null &&
            "purpose" in meta &&
            meta.purpose === purpose
          );
        },
      );
      if (matches.length > 1)
        throw new Error(
          "ScheduleCapability: duplicate purpose requires reconciliation",
        );
      const existing = matches[0];
      if (existing) {
        if (
          existing.graphId !== input.graphId ||
          existing.cron !== input.cron ||
          existing.timezone !== input.timezone ||
          !isDeepStrictEqual(existing.input, boundInput)
        ) {
          throw new Error(
            "ScheduleCapability: purpose already exists with different configuration; read and reconcile it",
          );
        }
        return toScheduleInfo(existing);
      }
      const billingAccountId = await getOrCreateBillingAccountId(userId);
      const spec = await scheduleManager.createSchedule(
        userId,
        billingAccountId,
        {
          nodeId: getNodeId(),
          graphId: input.graphId,
          input: boundInput,
          cron: input.cron,
          timezone: input.timezone,
        },
      );
      return toScheduleInfo(spec);
    },

    async update(
      scheduleId: string,
      patch: ScheduleUpdateParams,
    ): Promise<ScheduleInfo> {
      const userId = resolveUserId();
      if (
        patch.input !== undefined ||
        patch.cron !== undefined ||
        patch.timezone !== undefined
      ) {
        throw new Error(
          "ScheduleCapability: configuration updates are unavailable until Temporal propagation is supported",
        );
      }
      const spec = await scheduleManager.updateSchedule(
        userId,
        scheduleId,
        patch,
      );
      return toScheduleInfo(spec);
    },

    async remove(scheduleId: string): Promise<void> {
      const userId = resolveUserId();
      await scheduleManager.deleteSchedule(userId, scheduleId);
    },

    async setEnabled(
      scheduleId: string,
      enabled: boolean,
    ): Promise<ScheduleInfo> {
      const userId = resolveUserId();
      const spec = await scheduleManager.updateSchedule(userId, scheduleId, {
        enabled,
      });
      return toScheduleInfo(spec);
    },
  };
}
