// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** One bounded, operator-readable health check for the complete node Temporal substrate. */
import {
  graphActivityResultSchema,
  scheduledGraphPayloadSchema,
  workerReadySnapshotSchema,
  workflowDeploymentName,
  workflowScheduleId,
} from "@cogni-dao/agent-workflow-runtime";
import {
  AGENT_WORKFLOW_CATCHUP_WINDOW_MS,
  listOrphanedWorkflowSchedules,
} from "@cogni-dao/agent-workflow-runtime/schedule";
import { ScheduleOverlapPolicy } from "@temporalio/client";
import {
  connectAgentWorkflowTemporal,
  inspectWorkerDeployment,
} from "@/adapters/server/temporal";
import { getContainer } from "@/bootstrap/container";
import { getNodeId, getNodeSchedules } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import {
  temporalScheduleDrift,
  temporalSubstrateCheckDurationSeconds,
  temporalSubstrateChecksTotal,
  temporalSubstrateLastSuccessTimestampSeconds,
  temporalSubstratePollers,
} from "@/shared/observability";

type HealthReason =
  | "ok"
  | "not_configured"
  | "runtime_config_missing"
  | "worker_unreachable"
  | "worker_identity_mismatch"
  | "worker_pollers_missing"
  | "deployment_not_current"
  | "schedule_drift"
  | "latest_run_missing"
  | "latest_run_failed"
  | "temporal_unavailable";

interface ScheduleHealth {
  readonly id: string;
  readonly temporalScheduleId: string;
  readonly drift: boolean;
  readonly latestRun: null | {
    readonly workflowId: string;
    readonly runId: string | null;
    readonly status: string;
    readonly graphRunId: string | null;
    readonly traceId: string | null;
  };
}

export interface AgentWorkflowHealth {
  readonly status: "healthy" | "unhealthy";
  readonly reason: HealthReason;
  readonly nodeId: string;
  readonly namespace: string | null;
  readonly taskQueue: string;
  readonly deploymentName: string;
  readonly buildId: string | null;
  readonly worker: unknown | null;
  readonly deployment: unknown | null;
  readonly schedules: readonly ScheduleHealth[];
  readonly orphanedScheduleIds: readonly string[];
  readonly checkedAt: string;
  readonly durationMs: number;
}

interface RecentScheduleAction {
  readonly action: {
    readonly type: "startWorkflow";
    readonly workflow: {
      readonly workflowId: string;
      readonly firstExecutionRunId: string;
    };
  };
}

function actionDrift(
  action: unknown,
  expected: {
    workflowType: string;
    taskQueue: string;
    scheduleId: string;
    graphId: string;
    input: Record<string, unknown>;
  }
): boolean {
  if (!action || typeof action !== "object") return true;
  const value = action as {
    type?: string;
    workflowType?: string;
    taskQueue?: string;
    args?: unknown[];
  };
  const input = value.args?.[0] as Record<string, unknown> | undefined;
  return (
    value.type !== "startWorkflow" ||
    value.workflowType !== expected.workflowType ||
    value.taskQueue !== expected.taskQueue ||
    input?.scheduleId !== expected.scheduleId ||
    input?.graphId !== expected.graphId ||
    JSON.stringify(input?.input) !== JSON.stringify(expected.input)
  );
}

function scheduleDrift(
  description: {
    readonly action: unknown;
    readonly spec: {
      readonly cronExpressions?: readonly string[];
      readonly timezone?: string;
    };
    readonly policies: {
      readonly overlap: ScheduleOverlapPolicy;
      readonly catchupWindow: number;
    };
    readonly state: { readonly paused: boolean };
  },
  expected: Parameters<typeof actionDrift>[1] & {
    readonly cron: string;
    readonly timezone: string;
  }
): boolean {
  return (
    actionDrift(description.action, expected) ||
    description.spec.cronExpressions?.length !== 1 ||
    description.spec.cronExpressions[0] !== expected.cron ||
    description.spec.timezone !== expected.timezone ||
    description.policies.overlap !== ScheduleOverlapPolicy.SKIP ||
    description.policies.catchupWindow !== AGENT_WORKFLOW_CATCHUP_WINDOW_MS ||
    description.state.paused
  );
}

export async function checkAgentWorkflowHealth(): Promise<AgentWorkflowHealth> {
  const startedAt = performance.now();
  const env = serverEnv();
  const container = getContainer();
  const nodeId = getNodeId();
  const deploymentName = workflowDeploymentName(nodeId);
  const buildId = env.APP_BUILD_SHA ?? null;
  const namespace = env.AGENT_WORKFLOW_TEMPORAL_NAMESPACE ?? null;
  const workflows = getNodeSchedules().filter(
    (schedule) => schedule.kind === "workflow"
  );
  let reason: HealthReason = "temporal_unavailable";
  let worker: unknown | null = null;
  let deployment: unknown | null = null;
  const schedules: ScheduleHealth[] = [];
  let orphanedScheduleIds: string[] = [];

  try {
    const runtimeConfigured = Boolean(
      env.AGENT_WORKFLOW_TEMPORAL_ADDRESS &&
        namespace &&
        env.AGENT_WORKFLOW_WORKER_HEALTH_URL &&
        buildId
    );
    if (workflows.length === 0 && !runtimeConfigured) {
      reason = "not_configured";
    } else if (
      !runtimeConfigured ||
      !env.AGENT_WORKFLOW_TEMPORAL_ADDRESS ||
      !namespace ||
      !env.AGENT_WORKFLOW_WORKER_HEALTH_URL ||
      !buildId
    ) {
      reason = "runtime_config_missing";
    } else {
      let workerResponse: Response;
      try {
        workerResponse = await fetch(
          `${env.AGENT_WORKFLOW_WORKER_HEALTH_URL}/readyz`,
          { signal: AbortSignal.timeout(3_000) }
        );
        worker = workerReadySnapshotSchema.parse(await workerResponse.json());
      } catch {
        reason = "worker_unreachable";
        throw new Error(reason);
      }

      const workerSnapshot = workerReadySnapshotSchema.parse(worker);
      if (
        !workerResponse.ok ||
        workerSnapshot.nodeId !== nodeId ||
        workerSnapshot.namespace !== namespace ||
        workerSnapshot.taskQueue !== env.AGENT_WORKFLOW_TEMPORAL_TASK_QUEUE ||
        workerSnapshot.deploymentName !== deploymentName ||
        workerSnapshot.buildId !== buildId ||
        workflows.some(
          (schedule) =>
            !schedule.workflow ||
            !workerSnapshot.workflows.includes(schedule.workflow)
        )
      ) {
        reason = "worker_identity_mismatch";
        throw new Error(reason);
      }
      const workflowPoller = workerSnapshot.pollers.workflow === "POLLING";
      const activityPoller = workerSnapshot.pollers.activity === "POLLING";
      temporalSubstratePollers.set({ task_type: "workflow" }, workflowPoller ? 1 : 0);
      temporalSubstratePollers.set({ task_type: "activity" }, activityPoller ? 1 : 0);
      if (!workflowPoller || !activityPoller) {
        reason = "worker_pollers_missing";
        throw new Error(reason);
      }

      const temporal = await connectAgentWorkflowTemporal({
        address: env.AGENT_WORKFLOW_TEMPORAL_ADDRESS,
        namespace,
      });
      try {
        const deploymentState = await inspectWorkerDeployment({
          client: temporal.client,
          namespace,
          deploymentName,
          buildId,
        });
        deployment = deploymentState;
        if (!deploymentState.visible || !deploymentState.current) {
          reason = "deployment_not_current";
          throw new Error(reason);
        }

        for (const schedule of workflows) {
          const payload = scheduledGraphPayloadSchema.parse(schedule.payload);
          const temporalScheduleId = workflowScheduleId(nodeId, schedule.id);
          const description = await temporal.client.schedule
            .getHandle(temporalScheduleId)
            .describe()
            .catch(() => {
              reason = "schedule_drift";
              throw new Error(reason);
            });
          const drift = scheduleDrift(description, {
            workflowType: schedule.workflow ?? "",
            taskQueue: env.AGENT_WORKFLOW_TEMPORAL_TASK_QUEUE,
            scheduleId: schedule.id,
            graphId: payload.graphId,
            input: payload.input,
            cron: schedule.cron,
            timezone: schedule.timezone,
          });
          const recent = (
            description.info as unknown as {
              recentActions?: readonly RecentScheduleAction[];
            }
          ).recentActions?.at(-1);
          const execution = recent?.action.workflow;
          let latestRun: ScheduleHealth["latestRun"] = null;
          if (execution?.workflowId) {
            const handle = temporal.client.workflow.getHandle(
              execution.workflowId,
              execution.firstExecutionRunId
            );
            const executionDescription = await handle.describe();
            const status = executionDescription.status.name;
            const result =
              status === "COMPLETED"
                ? graphActivityResultSchema.parse(await handle.result())
                : null;
            latestRun = {
              workflowId: execution.workflowId,
              runId: execution.firstExecutionRunId,
              status,
              graphRunId: result?.runId ?? null,
              traceId: result?.traceId ?? null,
            };
          }
          schedules.push({ id: schedule.id, temporalScheduleId, drift, latestRun });
        }
        orphanedScheduleIds = await listOrphanedWorkflowSchedules(
          temporal.client,
          nodeId,
          workflows.map((schedule) => schedule.id)
        );
      } finally {
        await temporal.close();
      }

      const driftCount =
        schedules.filter((schedule) => schedule.drift).length +
        orphanedScheduleIds.length;
      temporalScheduleDrift.set(driftCount);
      if (driftCount > 0) reason = "schedule_drift";
      else if (schedules.some((schedule) => !schedule.latestRun)) reason = "latest_run_missing";
      else if (schedules.some((schedule) => schedule.latestRun?.status !== "COMPLETED")) reason = "latest_run_failed";
      else reason = "ok";
    }
  } catch {
    // `reason` is set at the failing boundary; the response is intentionally bounded.
  }

  const status = reason === "ok" ? "healthy" : "unhealthy";
  const durationMs = Math.round(performance.now() - startedAt);
  temporalSubstrateChecksTotal.inc({ result: status, reason });
  temporalSubstrateCheckDurationSeconds.observe(
    { result: status, reason },
    durationMs / 1_000
  );
  if (status === "healthy") {
    temporalSubstrateLastSuccessTimestampSeconds.set(Date.now() / 1_000);
  }
  container.log[status === "healthy" ? "info" : "error"](
    {
      event: "substrate.temporal.health_checked",
      outcome: status === "healthy" ? "success" : "error",
      reasonCode: reason,
      buildId,
      scheduleCount: workflows.length,
      driftCount: schedules.filter((schedule) => schedule.drift).length,
      orphanedScheduleCount: orphanedScheduleIds.length,
      durationMs,
    },
    "substrate.temporal.health_checked"
  );
  return {
    status,
    reason,
    nodeId,
    namespace,
    taskQueue: env.AGENT_WORKFLOW_TEMPORAL_TASK_QUEUE,
    deploymentName,
    buildId,
    worker,
    deployment,
    schedules,
    orphanedScheduleIds,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}
