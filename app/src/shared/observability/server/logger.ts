// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/logging/logger`
 * Purpose: Pino logger factory - JSON-only stdout emission.
 * Scope: Create configured pino loggers. Does not handle request-scoped logging.
 * Invariants: Always emits JSON to stdout; no worker transports; env label added by Alloy. Safe to call at module scope (no env validation).
 *   On lease deployments (LOKI_PUSH_URL injected by the operator, bug.5127) stdout is additionally teed to the in-process,
 *   fail-open Loki push sink — stdout emission is unchanged and the sink can never crash or block the app.
 *   Invalid PINO_LOG_LEVEL uses info for diagnostics; environment validation still rejects it.
 * Side-effects: none
 * Notes: Base fields include buildSha/workload/host (bug.0040) from existing env; see makeIdentityFields.
 * Notes: Use makeLogger for app logger; use makeNoopLogger for tests. Formatting via external pipe (pino-pretty).
 * Notes: Reads logging-specific env vars directly (NODE_ENV, PINO_LOG_LEVEL, SERVICE_NAME) without serverEnv() to avoid triggering full env validation at module load time.
 * Links: Initializes redaction paths via REDACT_PATHS; used by container and route handlers.
 * @public
 */

import type { Logger } from "pino";
import pino from "pino";

import { getLokiPushStream } from "./loki-push-stream";
import { REDACT_PATHS } from "./redact";

export type { Logger } from "pino";

/**
 * Build/lane identity stamped on every app log line (bug.0040). Both candidate-a workloads share
 * one image family and one Loki node stream, so a line must name the build and lane that wrote it.
 * Absent values are omitted (never emitted as empty strings).
 *   buildSha: APP_BUILD_SHA (what /version serves), else the operator-injected COGNI_REPO_SHA.
 *   workload: COGNI_WORKLOAD when the deployer injects it.
 *   host:     hostname of APP_BASE_URL (operator-injected, distinct per workload lane).
 */
export function makeIdentityFields(
  env: Readonly<Record<string, string | undefined>>,
): { buildSha?: string; workload?: string; host?: string } {
  const buildSha = env.APP_BUILD_SHA || env.COGNI_REPO_SHA || undefined;
  const workload = env.COGNI_WORKLOAD || undefined;
  let host: string | undefined;
  try {
    host = env.APP_BASE_URL ? new URL(env.APP_BASE_URL).hostname : undefined;
  } catch {
    host = undefined;
  }
  return {
    ...(buildSha ? { buildSha } : {}),
    ...(workload ? { workload } : {}),
    ...(host ? { host } : {}),
  };
}

export function makeLogger(bindings?: Record<string, unknown>): Logger {
  const isVitest = process.env.VITEST === "true";
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const configuredLevel = process.env.PINO_LOG_LEVEL ?? "info";
  // Keep diagnostic logging available when env validation rejects this field.
  const pinoLogLevel = ["trace", "debug", "info", "warn", "error"].includes(
    configuredLevel,
  )
    ? configuredLevel
    : "info";
  const serviceName = process.env.SERVICE_NAME ?? "app";

  // Silence logs in test tooling (VITEST or NODE_ENV=test)
  const isTestTooling = isVitest || nodeEnv === "test";

  const config = {
    level: pinoLogLevel,
    enabled: !isTestTooling,
    // Stable base: bindings first, then reserved keys (prevents overwrite)
    // env label added by Alloy from DEPLOY_ENVIRONMENT, not in app logs
    base: {
      ...bindings,
      ...makeIdentityFields(process.env),
      app: "cogni-template",
      service: serviceName,
    },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime, // RFC3339 format (matches Alloy stage.timestamp)
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };

  // Always emit JSON to stdout (fd 1)
  // Sync mode + zero buffering until proven stable (prevents delayed/missing logs under SSE)
  // Formatting happens externally (pipe to pino-pretty if desired)
  const stdout = pino.destination({
    dest: 1,
    sync: true,
    minLength: 0,
  });

  // Lease deployments only (bug.5127): when the operator injected LOKI_PUSH_URL,
  // tee every line to the in-process Loki push sink. Absent that env (k3s,
  // local, tests) this is exactly the historical single-destination logger.
  const lokiPush = getLokiPushStream();
  return pino(
    config,
    lokiPush
      ? pino.multistream(
          [
            { level: pinoLogLevel as pino.Level, stream: stdout },
            { level: pinoLogLevel as pino.Level, stream: lokiPush },
          ],
          { dedupe: false },
        )
      : stdout,
  );
}

/**
 * For tests - pino with enabled:false (preserves type, silences output)
 */
export function makeNoopLogger(): Logger {
  return pino({ enabled: false });
}
