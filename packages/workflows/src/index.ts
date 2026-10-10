import {
  type GraphActivityInput,
  type GraphActivityResult,
  graphActivityInputSchema,
  scheduledGraphWorkflowInputSchema,
  SCHEDULED_GRAPH_WORKFLOW_TYPE,
} from "@cogni-dao/agent-workflow-runtime";
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

function scheduledForIso(): string {
  return workflowInfo().startTime.toISOString();
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
