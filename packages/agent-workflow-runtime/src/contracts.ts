import { z } from "zod";

export const AGENT_WORKFLOW_TASK_QUEUE = "agent-workflows" as const;
export const SCHEDULED_GRAPH_WORKFLOW_TYPE =
  "ScheduledGraphWorkflow" as const;

const sourceShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "source SHA must be 40 lowercase hex characters");

export const scheduledGraphPayloadSchema = z
  .object({
    graphId: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();

export const scheduledGraphWorkflowInputSchema = scheduledGraphPayloadSchema
  .extend({
    scheduleId: z.string().min(1),
    executionGrantId: z.string().uuid(),
  })
  .strict();

export const graphActivityInputSchema = scheduledGraphWorkflowInputSchema
  .extend({
    scheduledFor: z.string().datetime(),
    workflowId: z.string().min(1),
  })
  .strict();

export const graphActivityResultSchema = z
  .object({
    ok: z.literal(true),
    runId: z.string(),
    traceId: z.string().nullable(),
  })
  .passthrough();

export const workerReadySnapshotSchema = z
  .object({
    status: z.enum(["healthy", "unhealthy"]),
    nodeId: z.string().uuid(),
    namespace: z.string().min(1),
    taskQueue: z.string().min(1),
    deploymentName: z.string().min(1),
    buildId: sourceShaSchema,
    workflows: z.array(z.string().min(1)),
    pollers: z.object({
      workflow: z.enum(["POLLING", "SHUTDOWN", "FAILED"]),
      activity: z.enum(["POLLING", "SHUTDOWN", "FAILED"]),
    }),
  })
  .strict();

export type ScheduledGraphPayload = z.infer<
  typeof scheduledGraphPayloadSchema
>;
export type ScheduledGraphWorkflowInput = z.infer<
  typeof scheduledGraphWorkflowInputSchema
>;
export type GraphActivityInput = z.infer<typeof graphActivityInputSchema>;
export type GraphActivityResult = z.infer<typeof graphActivityResultSchema>;
export type WorkerReadySnapshot = z.infer<typeof workerReadySnapshotSchema>;

export function workflowDeploymentName(nodeId: string): string {
  return `node-${nodeId}-workflows`;
}

export function workflowScheduleId(nodeId: string, id: string): string {
  return `node-workflow:${nodeId}:${id}`;
}
