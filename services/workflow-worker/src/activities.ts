import {
  type GraphActivityInput,
  type GraphActivityResult,
  graphActivityInputSchema,
  graphActivityResultSchema,
} from "@cogni-dao/agent-workflow-runtime";
import { heartbeat, log } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";

import type { WorkerEnv } from "./env.js";

class GraphActivityHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reasonCode: "app_request_rejected" | "app_request_failed"
  ) {
    super(`Node app graph Activity failed with ${status}`);
    this.name = "GraphActivityHttpError";
  }
}

export function createActivities(config: WorkerEnv) {
  return {
    async runGraph(rawInput: GraphActivityInput): Promise<GraphActivityResult> {
      const input = graphActivityInputSchema.parse(rawInput);
      const startedAt = performance.now();
      const idempotencyKey = `${input.scheduleId}:${input.scheduledFor}`;
      const heartbeatTimer = setInterval(() => heartbeat("graph-running"), 10_000);
      try {
        const response = await fetch(
          `${config.NODE_APP_URL}/api/internal/graphs/${encodeURIComponent(input.graphId)}/runs`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.SCHEDULER_API_TOKEN}`,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify({
              executionGrantId: input.executionGrantId,
              input: input.input,
            }),
          }
        );
        if (!response.ok) {
          const reasonCode =
            response.status >= 400 && response.status < 500
              ? "app_request_rejected"
              : "app_request_failed";
          throw new GraphActivityHttpError(response.status, reasonCode);
        }
        const result = graphActivityResultSchema.parse(await response.json());
        log.info("substrate.temporal.graph_activity_completed", {
          outcome: "success",
          graphId: input.graphId,
          workflowId: input.workflowId,
          scheduleId: input.scheduleId,
          runId: result.runId,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return result;
      } catch (error) {
        const reasonCode =
          error instanceof GraphActivityHttpError
            ? error.reasonCode
            : "activity_exception";
        log.error("substrate.temporal.graph_activity_completed", {
          outcome: "error",
          reasonCode,
          ...(error instanceof GraphActivityHttpError
            ? { status: error.status }
            : {}),
          graphId: input.graphId,
          workflowId: input.workflowId,
          scheduleId: input.scheduleId,
          durationMs: Math.round(performance.now() - startedAt),
        });
        if (
          error instanceof GraphActivityHttpError &&
          error.reasonCode === "app_request_rejected"
        ) {
          throw ApplicationFailure.nonRetryable(error.message, reasonCode);
        }
        throw error;
      } finally {
        clearInterval(heartbeatTimer);
      }
    },
  };
}
