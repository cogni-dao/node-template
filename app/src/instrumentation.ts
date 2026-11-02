// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Next compiles this entry for Node and Edge; load native telemetry only in Node. */
import type { NodeSDK } from "@opentelemetry/sdk-node";

let nodeInstrumentation: typeof import("./instrumentation.node") | null = null;

export async function initOtelSdk(options?: {
  failOnError?: boolean;
}): Promise<boolean> {
  // biome-ignore lint/style/noProcessEnv: Next replaces NEXT_RUNTIME at compilation
  if (process.env.NEXT_RUNTIME !== "edge") {
    nodeInstrumentation ??= await import("./instrumentation.node");
    return nodeInstrumentation.initOtelSdk(options);
  }
  return false;
}

export async function register(): Promise<void> {
  // biome-ignore lint/style/noProcessEnv: Next replaces NEXT_RUNTIME at compilation
  if (process.env.NEXT_RUNTIME === "nodejs") {
    nodeInstrumentation ??= await import("./instrumentation.node");
    await nodeInstrumentation.register();
  }
}

export function getOtelSdk(): NodeSDK | null {
  return nodeInstrumentation?.getOtelSdk() ?? null;
}
