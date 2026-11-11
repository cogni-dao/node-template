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
  logRequestError,
  logRequestStart,
  makeLogger,
  type RequestContext,
  statusBucket,
} from "@/shared/observability";
import { setBuildInfo } from "@/shared/observability/server/metrics";
import { buildDeepChecks, deepRuntime } from "./readyz-probes";

export const dynamic = "force-dynamic";

/**
 * Logs readiness check failure with structured context.
 * Called before returning 503 to ensure failures are visible in deployment logs.
 */
function logReadinessFailure(
  ctx: RequestContext,
  error:
    | EnvValidationError
    | RuntimeSecretError
    | InfraConnectivityError
    | Error,
): void {
  if (error instanceof EnvValidationError) {
    ctx.log.error(
      {
        reason: error.meta.code,
        missing: error.meta.missing,
        invalid: error.meta.invalid,
      },
      "readiness check failed: invalid environment configuration",
    );
  } else if (error instanceof RuntimeSecretError) {
    ctx.log.error(
      {
        reason: error.code,
        message: error.message,
      },
      "readiness check failed: missing runtime secret",
    );
  } else if (error instanceof InfraConnectivityError) {
    ctx.log.error(
      {
        reason: error.code,
        message: error.message,
      },
      "readiness check failed: infrastructure unreachable",
    );
  } else {
    // pg/drizzle errors wrap the driver error (with its SQLSTATE `code`) in `cause`.
    const cause = (error as { cause?: { code?: unknown; message?: unknown } })
      .cause;
    ctx.log.error(
      {
        reason: "INTERNAL_ERROR",
        error: error.message,
        causeCode: cause?.code,
        causeMessage: cause?.message,
      },
      "readiness check failed: internal error",
    );
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const start = performance.now();
  return withRootSpan(
    "GET meta.readyz",
    { route_id: "meta.readyz" },
    async ({ traceId, span }) => {
      const log = makeLogger({ service: "cogni-template" });
      const ctx = createRequestContext(
        { baseLog: log, clock: { now: () => new Date().toISOString() } },
        request,
        { routeId: "meta.readyz", traceId },
      );
      span.setAttribute("request_id", ctx.reqId);
      let status = 500;
      try {
        // Configuration refusals still get a request envelope; other invariants stay fatal.
        try {
          ctx.log = ctx.log.child({ nodeId: getNodeId() });
        } catch (error) {
          if (
            !(
              error instanceof EnvValidationError ||
              error instanceof RuntimeSecretError
            )
          )
            throw error;
        }
        logRequestStart(ctx.log);
        const deep = new URL(request.url).searchParams.get("deep") === "1";
        const result = await serveReadyz({
          deep,
          local: () => {
            const env = localReadinessPreflight();
            setBuildInfo(
              process.env.npm_package_version || "unknown",
              env.APP_BUILD_SHA || "unknown",
            );
            return {
              buildSha: env.APP_BUILD_SHA || undefined,
              version: process.env.npm_package_version || undefined,
            };
          },
          deepChecks: () => buildDeepChecks(ctx, getContainer(), serverEnv()),
          runtime: deepRuntime(ctx),
          onFailure: (error) => logReadinessFailure(ctx, error as Error),
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
        status = result.status;
        return NextResponse.json(body, { status });
      } catch (error) {
        logRequestError(ctx.log, error, "INTERNAL_SERVER_ERROR");
        throw error;
      } finally {
        const durationMs = performance.now() - start;
        logRequestEnd(ctx.log, { status, durationMs });
        httpRequestsTotal.inc({
          route: "meta.readyz",
          method: request.method,
          status: statusBucket(status),
        });
        httpRequestDurationMs.observe(
          { route: "meta.readyz", method: request.method },
          durationMs,
        );
      }
    },
  );
}
