// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Node-sovereign Temporal client seam for workflow reconciliation and health. */
import { Client, Connection } from "@temporalio/client";

export interface AgentWorkflowTemporalConfig {
  readonly address: string;
  readonly namespace: string;
}

export interface AgentWorkflowTemporalClient {
  readonly client: Client;
  readonly connection: Connection;
  close(): Promise<void>;
}

export async function connectAgentWorkflowTemporal(
  config: AgentWorkflowTemporalConfig
): Promise<AgentWorkflowTemporalClient> {
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  return {
    client,
    connection,
    close: () => connection.close(),
  };
}

interface WorkerDeploymentDescription {
  readonly conflictToken?: Uint8Array;
  readonly workerDeploymentInfo?: {
    readonly versionSummaries?: ReadonlyArray<{ readonly version?: string }>;
    readonly routingConfig?: {
      readonly currentVersion?: string;
      readonly currentDeploymentVersion?: {
        readonly deploymentName?: string;
        readonly buildId?: string;
      };
    };
  };
}

interface WorkerDeploymentService {
  describeWorkerDeployment(input: {
    namespace: string;
    deploymentName: string;
  }): Promise<WorkerDeploymentDescription>;
  setWorkerDeploymentCurrentVersion(input: {
    namespace: string;
    deploymentName: string;
    version: string;
    conflictToken?: Uint8Array;
  }): Promise<unknown>;
}

function deploymentService(client: Client): WorkerDeploymentService {
  return client.workflowService as unknown as WorkerDeploymentService;
}

export interface WorkerDeploymentState {
  readonly visible: boolean;
  readonly current: boolean;
  readonly version: string;
}

/**
 * Make the exact app/Worker source build current only after Temporal can see it.
 * New scheduled runs are therefore never routed to an unobserved Worker build.
 */
export async function activateExactWorkerDeployment(input: {
  readonly client: Client;
  readonly namespace: string;
  readonly deploymentName: string;
  readonly buildId: string;
}): Promise<WorkerDeploymentState> {
  const service = deploymentService(input.client);
  const version = `${input.deploymentName}.${input.buildId}`;
  const description = await service.describeWorkerDeployment({
    namespace: input.namespace,
    deploymentName: input.deploymentName,
  });
  const info = description.workerDeploymentInfo;
  const visible = Boolean(
    info?.versionSummaries?.some((summary) => summary.version === version)
  );
  if (!visible) return { visible: false, current: false, version };

  const currentVersion =
    info?.routingConfig?.currentVersion ??
    (info?.routingConfig?.currentDeploymentVersion?.deploymentName &&
    info.routingConfig.currentDeploymentVersion.buildId
      ? `${info.routingConfig.currentDeploymentVersion.deploymentName}.${info.routingConfig.currentDeploymentVersion.buildId}`
      : undefined);
  if (currentVersion !== version) {
    const conflictToken = description.conflictToken;
    await service.setWorkerDeploymentCurrentVersion({
      namespace: input.namespace,
      deploymentName: input.deploymentName,
      version,
      ...(conflictToken ? { conflictToken } : {}),
    });
    for (let attempt = 0; attempt < 10; attempt++) {
      const verified = await inspectWorkerDeployment(input);
      if (verified.current) return verified;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { visible: true, current: false, version };
  }
  return { visible: true, current: true, version };
}

export async function inspectWorkerDeployment(input: {
  readonly client: Client;
  readonly namespace: string;
  readonly deploymentName: string;
  readonly buildId: string;
}): Promise<WorkerDeploymentState> {
  const version = `${input.deploymentName}.${input.buildId}`;
  const description = await deploymentService(
    input.client
  ).describeWorkerDeployment({
    namespace: input.namespace,
    deploymentName: input.deploymentName,
  });
  const info = description.workerDeploymentInfo;
  const visible = Boolean(
    info?.versionSummaries?.some((summary) => summary.version === version)
  );
  const currentVersion =
    info?.routingConfig?.currentVersion ??
    (info?.routingConfig?.currentDeploymentVersion?.deploymentName &&
    info.routingConfig.currentDeploymentVersion.buildId
      ? `${info.routingConfig.currentDeploymentVersion.deploymentName}.${info.routingConfig.currentDeploymentVersion.buildId}`
      : undefined);
  return { visible, current: currentVersion === version, version };
}
