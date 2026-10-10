import {
  type Client,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
} from "@temporalio/client";

import { workflowScheduleId } from "./contracts.js";

export interface DesiredWorkflowSchedule {
  readonly id: string;
  readonly nodeId: string;
  readonly cron: string;
  readonly timezone: string;
  readonly workflowType: string;
  readonly taskQueue: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface WorkflowScheduleState {
  readonly scheduleId: string;
  readonly changed: boolean;
  readonly created: boolean;
  readonly paused: boolean;
  readonly fingerprint: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

export function workflowScheduleFingerprint(
  desired: DesiredWorkflowSchedule
): string {
  return JSON.stringify(
    stableValue({
      cron: desired.cron,
      timezone: desired.timezone,
      workflowType: desired.workflowType,
      taskQueue: desired.taskQueue,
      input: desired.input,
      overlap: "SKIP",
      catchupWindowMs: 0,
    })
  );
}

export async function reconcileWorkflowSchedule(
  client: Client,
  desired: DesiredWorkflowSchedule
): Promise<WorkflowScheduleState> {
  const scheduleId = workflowScheduleId(desired.nodeId, desired.id);
  const handle = client.schedule.getHandle(scheduleId);
  const fingerprint = workflowScheduleFingerprint(desired);
  let existing: Awaited<ReturnType<typeof handle.describe>> | null = null;
  try {
    existing = await handle.describe();
  } catch (error) {
    if (!(error instanceof ScheduleNotFoundError)) throw error;
  }

  const action = {
    type: "startWorkflow" as const,
    workflowType: desired.workflowType,
    workflowId: scheduleId,
    args: [desired.input],
    taskQueue: desired.taskQueue,
    memo: { cogniScheduleFingerprint: fingerprint },
  };
  const spec = {
    cronExpressions: [desired.cron],
    timezone: desired.timezone,
  };
  const policies = {
    overlap: ScheduleOverlapPolicy.SKIP,
    catchupWindow: 0,
  };

  if (!existing) {
    await client.schedule.create({
      scheduleId,
      spec,
      action,
      policies,
    });
    return {
      scheduleId,
      changed: true,
      created: true,
      paused: false,
      fingerprint,
    };
  }

  const previousFingerprint =
    existing.action.type === "startWorkflow" &&
    typeof existing.action.memo?.cogniScheduleFingerprint === "string"
      ? existing.action.memo.cogniScheduleFingerprint
      : null;
  const paused = existing.state.paused;
  if (previousFingerprint === fingerprint) {
    return { scheduleId, changed: false, created: false, paused, fingerprint };
  }

  await handle.update((previous) => ({
    spec,
    action,
    policies,
    state: previous.state,
  }));
  return { scheduleId, changed: true, created: false, paused, fingerprint };
}

export async function triggerWorkflowSchedule(
  client: Client,
  scheduleId: string
): Promise<void> {
  await client.schedule.getHandle(scheduleId).trigger(
    ScheduleOverlapPolicy.SKIP
  );
}
