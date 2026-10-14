import { z } from "zod";

const workerEnvSchema = z.object({
  TEMPORAL_ADDRESS: z.string().min(1),
  TEMPORAL_NAMESPACE: z.string().min(1),
  TEMPORAL_TASK_QUEUE: z.literal("agent-workflows"),
  TEMPORAL_WORKER_DEPLOYMENT_NAME: z.string().min(1),
  TEMPORAL_WORKER_BUILD_ID: z.string().regex(/^[0-9a-f]{40}$/),
  COGNI_NODE_ID: z.string().uuid(),
  NODE_APP_URL: z.string().url(),
  SCHEDULER_API_TOKEN: z.string().min(32),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(9100),
  PINO_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function parseWorkerEnv(input: NodeJS.ProcessEnv): WorkerEnv {
  return workerEnvSchema.parse(input);
}
