import {
  type GraphActivityInput,
  type GraphActivityResult,
  graphActivityInputSchema,
  scheduledGraphWorkflowInputSchema,
  SCHEDULED_GRAPH_WORKFLOW_TYPE,
} from "@cogni-dao/agent-workflow-runtime";
import {
  ApplicationFailure,
  defineSearchAttributeKey,
  SearchAttributeType,
} from "@temporalio/common";
import { proxyActivities, workflowInfo } from "@temporalio/workflow";

export interface NodeWorkflowActivities {
  runGraph(input: GraphActivityInput): Promise<GraphActivityResult>;
}

const { runGraph } = proxyActivities<NodeWorkflowActivities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 5,
  },
});

const temporalScheduledStartTime = defineSearchAttributeKey(
  "TemporalScheduledStartTime",
  SearchAttributeType.DATETIME
);

function scheduledForIso(): string {
  const scheduledFor = workflowInfo().typedSearchAttributes.get(
    temporalScheduledStartTime
  );
  if (!scheduledFor) {
    throw ApplicationFailure.nonRetryable(
      "ScheduledGraphWorkflow requires TemporalScheduledStartTime",
      "scheduled_start_time_missing"
    );
  }
  return scheduledFor.toISOString();
}

/** A node-owned durable Workflow containing one billed LangGraph graph run. */
export async function ScheduledGraphWorkflow(
  rawInput: unknown
): Promise<GraphActivityResult> {
  const input = scheduledGraphWorkflowInputSchema.parse(rawInput);
  const activityInput = graphActivityInputSchema.parse({
    ...input,
    scheduledFor: scheduledForIso(),
    workflowId: workflowInfo().workflowId,
  });
  return runGraph(activityInput);
}

export const NODE_WORKFLOW_TYPES = [SCHEDULED_GRAPH_WORKFLOW_TYPE] as const;
