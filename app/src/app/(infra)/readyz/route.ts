// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/readyz`
 * Purpose: HTTP readiness endpoint, served whole by `serveReadyz` from @cogni-dao/substrate-health (story.0040).
 * Scope: The default (kubelet) path validates env, runtime secrets and EVM RPC config only: zero remote calls. `?deep=1` additionally probes every dependency this node declares (registry: readyz-probes.ts).
 * Invariants: Always returns valid readyz schema; force-dynamic runtime. The default path makes no remote IO, so a slow or down shared substrate can neither delay it nor drain the fleet (incident 2026-06-26; bug.5378). Postgres provisioning is asserted once at boot (bootstrap/startup-assertions). `?deep=1` runs every declared check concurrently under DEEP_CHECK_BUDGET_MS; its body adds `checks`, and a deep 503 adds `unreachable` and `buildSha`. Readers parse it only through `readDeepReadiness`. Config errors (env, secrets) return before any check and carry no deep evidence. A CI parity test keeps the registry in sync with the env schema.
 * Side-effects: HTTP response and structured logging; network/database IO only with `?deep=1`.
 * Notes: Used by Docker HEALTHCHECK, deployment validation, K8s readiness probes.
 *        HTTP status is primary truth: 200 = ready, 503 = not ready.
 *        Provisioning / smoke checks that must assert the substrate is up call `/readyz?deep=1`.
 * Links: `@contracts/meta.readyz.read.v1.contract`, src/app/(infra)/readyz/readyz-probes.ts, src/shared/env/invariants.ts
 * @public
 */

import { metaReadyzOperation } from "@cogni/node-contracts";
import { serveReadyz } from "@cogni/substrate-health";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { localReadinessPreflight } from "@/bootstrap/local-readiness-preflight";
import { withRootSpan } from "@/bootstrap/otel";
import { getNodeId } from "@/shared/config";
import { EnvValidationError, serverEnv } from "@/shared/env";
import {
  InfraConnectivityError,
  RuntimeSecretError,
} from "@/shared/env/invariants";
import {
  createRequestContext,
  httpRequestDurationMs,
  httpRequestsTotal,
  logRequestEnd,
  makeLogger,
  statusBucket,
} from "@/shared/observability";
import { setBuildInfo } from "@/shared/observability/server/metrics";
import { buildDeepChecks, deepRuntime } from "./readyz-probes";

export const dynamic = "force-dynamic";

/** Classify diagnostics without retaining or logging the original error. */
function readinessErrorCode(error: unknown): string {
  return error instanceof EnvValidationError
    ? "INVALID_ENV"
    : error instanceof RuntimeSecretError
      ? "MISSING_RUNTIME_SECRET"
      : error instanceof InfraConnectivityError
        ? "INFRA_UNREACHABLE"
        : "INTERNAL_ERROR";
}

export async function GET(request: Request): Promise<NextResponse> {
  let start = 0;
  let status = 500;
  let errorCode: string | undefined;
  let settledResponse: NextResponse | undefined;
  let log: ReturnType<typeof makeLogger> | undefined;
  try {
    start = performance.now();
    return await withRootSpan(
      "GET meta.readyz",
      { route_id: "meta.readyz" },
      async ({ traceId, span }) => {
        log = makeLogger({
          service: "cogni-template",
          route: "meta.readyz",
          method: request.method,
          traceId,
        });
        const ctx = createRequestContext(
          { baseLog: log, clock: { now: () => new Date().toISOString() } },
          request,
          { routeId: "meta.readyz", traceId },
        );
        log = ctx.log;
        span.setAttribute("request_id", ctx.reqId);
        try {
          ctx.log = ctx.log.child({ nodeId: getNodeId() });
          log = ctx.log;
        } catch (error) {
          if (
            !(
              error instanceof EnvValidationError ||
              error instanceof RuntimeSecretError
            )
          )
            throw error;
        }
        const deep = new URL(request.url).searchParams.get("deep") === "1";
        const runtime = deepRuntime(ctx);
        const safeRuntime = {
          ...runtime,
          log: (...args: Parameters<typeof runtime.log>) => {
            try {
              runtime.log(...args);
            } catch {}
          },
        };
        const result = await serveReadyz({
          deep,
          local: () => {
            const env = localReadinessPreflight();
            try {
              setBuildInfo(
                process.env.npm_package_version || "unknown",
                env.APP_BUILD_SHA || "unknown",
              );
            } catch {}
            return {
              buildSha: env.APP_BUILD_SHA || undefined,
              version: process.env.npm_package_version || undefined,
            };
          },
          deepChecks: () => buildDeepChecks(ctx, getContainer(), serverEnv()),
          runtime: safeRuntime,
          onFailure: (error) => {
            try {
              errorCode = readinessErrorCode(error);
            } catch {
              errorCode = "INTERNAL_ERROR";
            }
          },
          describeError: (error) => {
            if (error instanceof EnvValidationError)
              return { reason: error.meta.code, details: error.meta };
            if (
              error instanceof RuntimeSecretError ||
              error instanceof InfraConnectivityError
            )
              return { reason: error.code, message: error.message };
            return { reason: "INTERNAL_ERROR" };
          },
        });
        const body =
          result.status === 200
            ? metaReadyzOperation.output.parse(result.body)
            : result.body;
        const response = NextResponse.json(body, { status: result.status });
        status = result.status;
        settledResponse = response;
        return response;
      },
    );
  } catch {
    if (settledResponse) return settledResponse;
    status = 500;
    errorCode = "INTERNAL_SERVER_ERROR";
    return new NextResponse(
      JSON.stringify({ status: "error", reason: "INTERNAL_ERROR" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  } finally {
    try {
      if (errorCode)
        log?.error(
          { errorCode },
          errorCode === "INTERNAL_SERVER_ERROR"
            ? "request failed"
            : "readiness check failed",
        );
    } catch {}
    let durationMs = 0;
    try {
      durationMs = performance.now() - start;
    } catch {}
    try {
      if (log) logRequestEnd(log, { status, durationMs });
    } catch {}
    try {
      httpRequestsTotal.inc({
        route: "meta.readyz",
        method: request.method,
        status: statusBucket(status),
      });
    } catch {}
    try {
      httpRequestDurationMs.observe(
        { route: "meta.readyz", method: request.method },
        durationMs,
      );
    } catch {}
  }
}
