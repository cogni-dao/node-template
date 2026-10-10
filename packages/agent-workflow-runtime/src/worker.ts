import { createServer, type Server } from "node:http";

import {
  NativeConnection,
  Worker,
  type WorkerOptions,
  type WorkerStatus,
} from "@temporalio/worker";
import client from "prom-client";

import {
  type WorkerReadySnapshot,
  workerReadySnapshotSchema,
} from "./contracts.js";

export interface RuntimeLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface NodeWorkflowWorkerConfig {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly nodeId: string;
  readonly deploymentName: string;
  readonly buildId: string;
  readonly healthHost: string;
  readonly healthPort: number;
}

export interface NodeWorkflowWorkerOptions {
  readonly config: NodeWorkflowWorkerConfig;
  readonly workflowsPath: string;
  readonly workflows: readonly string[];
  readonly activities: NonNullable<WorkerOptions["activities"]>;
  readonly logger: RuntimeLogger;
}

export interface RunningNodeWorkflowWorker {
  readonly worker: Worker;
  readonly server: Server;
  readonly runPromise: Promise<void>;
  close(): Promise<void>;
}

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const workerBuildInfo = new client.Gauge({
  name: "temporal_worker_build_info",
  help: "Identity of the running node workflow Worker",
  labelNames: ["node_id"],
  registers: [registry],
});
const workerPollerState = new client.Gauge({
  name: "temporal_worker_poller_ready",
  help: "Whether the local Workflow or Activity poller is polling",
  labelNames: ["node_id", "task_type"],
  registers: [registry],
});

function readiness(
  config: NodeWorkflowWorkerConfig,
  workflows: readonly string[],
  status: WorkerStatus
): WorkerReadySnapshot {
  const healthy =
    status.runState === "RUNNING" &&
    status.workflowPollerState === "POLLING" &&
    status.activityPollerState === "POLLING";
  return workerReadySnapshotSchema.parse({
    status: healthy ? "healthy" : "unhealthy",
    nodeId: config.nodeId,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    deploymentName: config.deploymentName,
    buildId: config.buildId,
    workflows: [...workflows].sort(),
    pollers: {
      workflow: status.workflowPollerState,
      activity: status.activityPollerState,
    },
  });
}

async function startHealthServer(input: {
  readonly config: NodeWorkflowWorkerConfig;
  readonly workflows: readonly string[];
  readonly worker: Worker;
}): Promise<Server> {
  const { config, workflows, worker } = input;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/readyz") {
      const snapshot = readiness(config, workflows, worker.getStatus());
      workerPollerState.set(
        { node_id: config.nodeId, task_type: "workflow" },
        snapshot.pollers.workflow === "POLLING" ? 1 : 0
      );
      workerPollerState.set(
        { node_id: config.nodeId, task_type: "activity" },
        snapshot.pollers.activity === "POLLING" ? 1 : 0
      );
      response.writeHead(snapshot.status === "healthy" ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(snapshot));
      return;
    }
    if (request.method === "GET" && request.url === "/metrics") {
      response.writeHead(200, { "content-type": registry.contentType });
      response.end(await registry.metrics());
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.healthPort, config.healthHost);
  });
  return server;
}

export async function startNodeWorkflowWorker(
  options: NodeWorkflowWorkerOptions
): Promise<RunningNodeWorkflowWorker> {
  const { config, logger } = options;
  const connection = await NativeConnection.connect({ address: config.address });
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: options.workflowsPath,
    activities: options.activities,
    identity: `${config.nodeId}:${config.buildId}`,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: {
        deploymentName: config.deploymentName,
        buildId: config.buildId,
      },
      defaultVersioningBehavior: "PINNED",
    },
  });
  workerBuildInfo.set({ node_id: config.nodeId }, 1);
  const server = await startHealthServer({
    config,
    workflows: options.workflows,
    worker,
  });
  const runPromise = worker.run();
  logger.info(
    {
      event: "substrate.temporal.worker_started",
      nodeId: config.nodeId,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      deploymentName: config.deploymentName,
      buildId: config.buildId,
      workflowCount: options.workflows.length,
    },
    "substrate.temporal.worker_started"
  );

  return {
    worker,
    server,
    runPromise,
    async close() {
      worker.shutdown();
      await runPromise;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await connection.close();
    },
  };
}
