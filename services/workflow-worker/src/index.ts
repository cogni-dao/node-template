import { createRequire } from "node:module";

import { startNodeWorkflowWorker } from "@cogni-dao/agent-workflow-runtime/worker";
import { NODE_WORKFLOW_TYPES } from "@cogni/node-template-workflows";
import pino from "pino";

import { createActivities } from "./activities.js";
import { parseWorkerEnv } from "./env.js";

const config = parseWorkerEnv(process.env);
const logger = pino({
  level: config.PINO_LOG_LEVEL,
  base: {
    service: "workflow-worker",
    nodeId: config.COGNI_NODE_ID,
  },
  messageKey: "msg",
  timestamp: pino.stdTimeFunctions.isoTime,
});
const require = createRequire(import.meta.url);

const running = await startNodeWorkflowWorker({
  config: {
    address: config.TEMPORAL_ADDRESS,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    nodeId: config.COGNI_NODE_ID,
    deploymentName: config.TEMPORAL_WORKER_DEPLOYMENT_NAME,
    buildId: config.TEMPORAL_WORKER_BUILD_ID,
    healthHost: config.HOST,
    healthPort: config.PORT,
  },
  workflowsPath: require.resolve("@cogni/node-template-workflows"),
  workflows: NODE_WORKFLOW_TYPES,
  activities: createActivities(config),
  logger,
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ event: "substrate.temporal.worker_stopping", signal }, "substrate.temporal.worker_stopping");
  await running.close();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await running.runPromise;
