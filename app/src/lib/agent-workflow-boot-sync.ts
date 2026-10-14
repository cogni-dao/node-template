// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Bounded startup trigger for node-owned Workflow schedule reconciliation. */
import pino from "pino";

const SYNC_ROUTE = "/api/internal/ops/temporal/schedules/sync";

export interface AgentWorkflowBootSyncConfig {
  readonly port: number;
  readonly token: string | null;
  readonly configured: boolean;
}

export function resolveAgentWorkflowBootSyncConfig(
  env: Partial<NodeJS.ProcessEnv>
): AgentWorkflowBootSyncConfig {
  return {
    port: Number(env.PORT ?? 3000),
    token: env.INTERNAL_OPS_TOKEN ?? null,
    configured: Boolean(
      env.AGENT_WORKFLOW_TEMPORAL_ADDRESS &&
        env.AGENT_WORKFLOW_TEMPORAL_NAMESPACE &&
        env.AGENT_WORKFLOW_WORKER_HEALTH_URL
    ),
  };
}

export async function runAgentWorkflowBootSync(
  config: AgentWorkflowBootSyncConfig,
  deps: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
  } = {}
): Promise<void> {
  if (!config.configured) return;
  const logger = pino({
    base: {
      app: "cogni-template",
      service: process.env.SERVICE_NAME ?? "app",
      component: "agent-workflow-boot-sync",
    },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  if (!config.token) {
    logger.error(
      { event: "substrate.temporal.boot_sync_completed", outcome: "error", reasonCode: "internal_ops_token_missing" },
      "substrate.temporal.boot_sync_completed"
    );
    return;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = deps.maxAttempts ?? 12;
  const url = `http://127.0.0.1:${config.port}${SYNC_ROUTE}`;
  let reasonCode = "endpoint_unavailable";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        logger.info(
          { event: "substrate.temporal.boot_sync_completed", outcome: "success", reasonCode: "ok", attempt },
          "substrate.temporal.boot_sync_completed"
        );
        return;
      }
      reasonCode = response.status >= 400 && response.status < 500
        ? "request_rejected"
        : "sync_failed";
      if (response.status >= 400 && response.status < 500) break;
    } catch {
      reasonCode = "endpoint_unavailable";
    }
    if (attempt < maxAttempts) await sleep(attempt * 1_000);
  }
  logger.error(
    { event: "substrate.temporal.boot_sync_completed", outcome: "error", reasonCode, maxAttempts },
    "substrate.temporal.boot_sync_completed"
  );
}
