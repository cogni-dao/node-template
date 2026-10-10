// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Reconcile node-owned Workflow schedules only after the exact Worker is ready. */
import {
  reconcileWorkflowSchedule,
  triggerWorkflowSchedule,
} from "@cogni-dao/agent-workflow-runtime/schedule";
import {
  scheduledGraphPayloadSchema,
  SCHEDULED_GRAPH_WORKFLOW_TYPE,
  workerReadySnapshotSchema,
  workflowDeploymentName,
} from "@cogni-dao/agent-workflow-runtime";
import { toUserId } from "@cogni/ids";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import {
  activateExactWorkerDeployment,
  connectAgentWorkflowTemporal,
} from "@/adapters/server/temporal";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { getContainer } from "@/bootstrap/container";
import { getNodeId, getNodeSchedules } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export interface AgentWorkflowSyncSummary {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly triggered: number;
  readonly buildId: string;
}

export async function runAgentWorkflowSchedulesSyncJob(): Promise<AgentWorkflowSyncSummary> {
  const startedAt = performance.now();
  const env = serverEnv();
  const container = getContainer();
  const workflows = getNodeSchedules().filter(
    (schedule) => schedule.kind === "workflow"
  );
  const buildId = env.APP_BUILD_SHA;
  const address = env.AGENT_WORKFLOW_TEMPORAL_ADDRESS;
  const namespace = env.AGENT_WORKFLOW_TEMPORAL_NAMESPACE;
  const workerHealthUrl = env.AGENT_WORKFLOW_WORKER_HEALTH_URL;

  let outcome: "success" | "error" = "error";
  let reasonCode = "sync_failed";
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let triggered = 0;

  try {
    if (workflows.length === 0) {
      outcome = "success";
      reasonCode = "no_workflows";
      return { created, updated, unchanged, triggered, buildId: buildId ?? "" };
    }
    if (!address || !namespace || !workerHealthUrl || !buildId) {
      reasonCode = "runtime_config_missing";
      throw new Error("Node workflow runtime configuration is incomplete");
    }

    const nodeId = getNodeId();
    const deploymentName = workflowDeploymentName(nodeId);
    const workerResponse = await fetch(`${workerHealthUrl}/readyz`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!workerResponse.ok) {
      reasonCode = "worker_not_ready";
      throw new Error(`Workflow Worker readiness returned ${workerResponse.status}`);
    }
    const worker = workerReadySnapshotSchema.parse(await workerResponse.json());
    const expectedTypes = workflows.map((schedule) => schedule.workflow);
    if (
      worker.status !== "healthy" ||
      worker.nodeId !== nodeId ||
      worker.namespace !== namespace ||
      worker.taskQueue !== env.AGENT_WORKFLOW_TEMPORAL_TASK_QUEUE ||
      worker.deploymentName !== deploymentName ||
      worker.buildId !== buildId ||
      expectedTypes.some((type) => !type || !worker.workflows.includes(type))
    ) {
      reasonCode = "worker_identity_mismatch";
      throw new Error("Workflow Worker readiness identity does not match app");
    }

    const serviceDb = getServiceDb();
    const reservedConn = await serviceDb.$client.reserve();
    const [lockRow] =
      await reservedConn`SELECT pg_try_advisory_lock(hashtext('agent_workflow_sync')) AS acquired`;
    const acquired = (lockRow as { acquired: boolean } | undefined)?.acquired;
    if (!acquired) {
      reservedConn.release();
      outcome = "success";
      reasonCode = "already_running";
      return { created, updated, unchanged, triggered, buildId };
    }

    let temporal: Awaited<ReturnType<typeof connectAgentWorkflowTemporal>> | null =
      null;
    try {
      temporal = await connectAgentWorkflowTemporal({ address, namespace });
      const deployment = await activateExactWorkerDeployment({
        client: temporal.client,
        namespace,
        deploymentName,
        buildId,
      });
      if (!deployment.visible || !deployment.current) {
        reasonCode = "worker_version_not_visible";
        throw new Error("Exact Worker version is not visible to Temporal");
      }

      const systemUserId = toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID);
      for (const schedule of workflows) {
        if (schedule.workflow !== SCHEDULED_GRAPH_WORKFLOW_TYPE) {
          reasonCode = "workflow_type_unsupported";
          throw new Error(`Unsupported node Workflow type: ${schedule.workflow}`);
        }
        const payload = scheduledGraphPayloadSchema.parse(schedule.payload);
        const grant = await container.executionGrantPort.ensureGrant({
          userId: systemUserId,
          billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
          scopes: [`graph:execute:${payload.graphId}`],
        });
        const state = await reconcileWorkflowSchedule(temporal.client, {
          id: schedule.id,
          nodeId,
          cron: schedule.cron,
          timezone: schedule.timezone,
          workflowType: schedule.workflow,
          taskQueue: env.AGENT_WORKFLOW_TEMPORAL_TASK_QUEUE,
          input: {
            ...payload,
            scheduleId: schedule.id,
            executionGrantId: grant.id,
          },
        });
        if (state.created) {
          created += 1;
          await triggerWorkflowSchedule(temporal.client, state.scheduleId);
          triggered += 1;
        } else if (state.changed) {
          updated += 1;
        } else {
          unchanged += 1;
        }
      }
    } finally {
      await temporal?.close();
      await reservedConn`SELECT pg_advisory_unlock(hashtext('agent_workflow_sync'))`;
      reservedConn.release();
    }

    outcome = "success";
    reasonCode = "ok";
    return { created, updated, unchanged, triggered, buildId };
  } finally {
    container.log[outcome === "success" ? "info" : "error"](
      {
        event: "substrate.temporal.schedule_sync_completed",
        outcome,
        reasonCode,
        buildId: buildId ?? null,
        scheduleCount: workflows.length,
        created,
        updated,
        unchanged,
        triggered,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "substrate.temporal.schedule_sync_completed"
    );
  }
}
