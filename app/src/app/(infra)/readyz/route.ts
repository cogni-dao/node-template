// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/readyz`
 * Purpose: HTTP readiness endpoint. The default (k8s probe) path answers only "can this pod serve HTTP?" — local serving readiness: env, runtime secrets, system tenant.
 * Scope: Validates env + runtime secrets + system tenant (fatal). Checks EVM RPC, Temporal, and scheduler-worker connectivity but treats transient failures as NON-FATAL on the default probe (logged, still 200). `?deep=1` restores hard substrate assertion for provisioning / stack-test smoke checks.
 * Invariants: Always returns valid readyz schema; force-dynamic runtime. Every managed non-test node requires and exercises EVM RPC even before payment activation. The default path does not drain the fleet for a transient upstream failure (incident 2026-06-26: scheduler-worker hiccup → fleet-wide 502); `?deep=1` forces a live RPC read and makes EVM RPC, Temporal, and scheduler-worker failures fatal (503).
 *             The default path runs every check concurrently and is bounded (task.5298): non-fatal checks get NON_FATAL_CHECK_BUDGET_MS and are reported degraded on timeout; the system tenant (DB verdict, still fatal → 503) gets SYSTEM_TENANT_BUDGET_MS and only its success is cached for SYSTEM_TENANT_OK_TTL_MS. The first probe after boot always performs the real DB check. `?deep=1` is concurrent and uncached; each check gets DEEP_CHECK_BUDGET_MS, not the default budgets.
 *             `?deep=1` probes exactly the Depend-class dependencies this node DECLARES, from the `SUBSTRATE_DEPENDENCIES` registry (readyz-probes.ts): evm-rpc, temporal, scheduler-worker, postgres, redis, litellm-gateway, and doltgres (only when DOLTGRES_URL is set). They run concurrently, each under DEEP_CHECK_BUDGET_MS, and a 503 body adds `unreachable`: every failing declared dependency. `reason`/`message` come from the first failure in registry order. Config errors (env, secrets) return before any check and carry no `unreachable`. The default path never adds the field and does no new IO. A CI parity test keeps the registry in sync with the env schema.
 * Side-effects: IO (HTTP response, structured logging, network calls to RPC, Temporal, LiteLLM, Redis, Doltgres)
 * Notes: Used by Docker HEALTHCHECK, deployment validation, K8s readiness probes.
 *        HTTP status is primary truth: 200 = ready, 503 = not ready.
 *        Provisioning / smoke checks that must assert the substrate is up call `/readyz?deep=1`.
 *        Logs readiness failures for deployment debugging.
 * Links: `@contracts/meta.readyz.read.v1.contract`, src/app/(infra)/readyz/readyz-probes.ts, src/shared/env/invariants.ts
 * @public
 */

import { metaReadyzOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EnvValidationError, serverEnv } from "@/shared/env";
import {
  assertEvmRpcConfig,
  assertRuntimeSecrets,
  assertSchedulerWorkerConnectivity,
  assertTemporalConnectivity,
  InfraConnectivityError,
  RuntimeSecretError,
} from "@/shared/env/invariants";
import type { RequestContext } from "@/shared/observability";
import { setBuildInfo } from "@/shared/observability/server/metrics";
import {
  assertSubstrate,
  buildDeepChecks,
  checkEvmRpc,
  type CheckTimings,
  checkSystemTenant,
  DeepProbeFailure,
  runDeepChecks,
  SLOW_READINESS_LOG_MS,
  timed,
} from "./readyz-probes";

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
    | Error
): void {
  if (error instanceof EnvValidationError) {
    ctx.log.error(
      {
        reason: error.meta.code,
        missing: error.meta.missing,
        invalid: error.meta.invalid,
      },
      "readiness check failed: invalid environment configuration"
    );
  } else if (error instanceof RuntimeSecretError) {
    ctx.log.error(
      {
        reason: error.code,
        message: error.message,
      },
      "readiness check failed: missing runtime secret"
    );
  } else if (error instanceof InfraConnectivityError) {
    ctx.log.error(
      {
        reason: error.code,
        message: error.message,
      },
      "readiness check failed: infrastructure unreachable"
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
      "readiness check failed: internal error"
    );
  }
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "meta.readyz", auth: { mode: "none" } },
  async (ctx, request): Promise<NextResponse> => {
    // `?deep=1` restores hard-fail substrate semantics for provisioning /
    // stack-test smoke checks; the default (k8s probe) path is non-fatal.
    const deep = new URL(request.url).searchParams.get("deep") === "1";
    try {
      const env = serverEnv();
      const container = getContainer();

      // Set build info for metrics (canonical source: APP_BUILD_SHA from serverEnv())
      setBuildInfo(
        process.env.npm_package_version || "unknown",
        env.APP_BUILD_SHA || "unknown"
      );

      // MVP readiness: env + runtime secrets (sync), then substrate checks.
      assertRuntimeSecrets(env);

      // EVM RPC is baseline node substrate, not conditional payment state.
      // Missing config is a deployment error. Transient connectivity remains
      // non-fatal for the default K8s probe so an upstream 429/blip cannot drain
      // the fleet; explicit deep readiness forces a fresh Base RPC read and
      // fails closed for birth/promotion proof.
      assertEvmRpcConfig(env);

      if (deep) {
        // Deep probe: concurrent, uncached, hard-fail. Probe exactly the
        // dependencies this node declares; every failing one is named in the
        // 503 body (`unreachable`). Registry: readyz-probes.ts.
        await runDeepChecks(buildDeepChecks(ctx, container, env));
      } else {
        // Default probe: run everything concurrently. Non-fatal checks are
        // bounded and degrade; only the system tenant (DB verdict) can 503.
        // This path is deliberately NOT driven by the registry: it stays the
        // minimal k8s serving check and adds no new IO.
        const temporalOpts = {
          ctx,
          deep: false,
          event: "substrate.temporal.unreachable",
          dependency: "temporal",
        };
        const schedulerWorkerOpts = {
          ctx,
          deep: false,
          event: "substrate.scheduler_worker.unreachable",
          dependency: "scheduler-worker",
        };
        const timings: CheckTimings = {};
        const startedAt = Date.now();
        const results = await Promise.allSettled([
          timed(timings, "evmRpc", () =>
            checkEvmRpc(ctx, container, env, false)
          ),
          timed(timings, "temporal", () =>
            assertSubstrate(
              () => assertTemporalConnectivity(container.scheduleControl, env),
              temporalOpts
            )
          ),
          timed(timings, "schedulerWorker", () =>
            assertSubstrate(
              () => assertSchedulerWorkerConnectivity(env),
              schedulerWorkerOpts
            )
          ),
          timed(timings, "systemTenant", () =>
            checkSystemTenant(container.serviceAccountService)
          ),
        ]);
        const durationMs = Date.now() - startedAt;
        const unhealthy = Object.values(timings).some(
          (check) => check.status !== "ok" && check.status !== "cached"
        );
        const summary = { checks: timings, durationMs };
        if (unhealthy || durationMs >= SLOW_READINESS_LOG_MS) {
          ctx.log.info(summary, "readiness: checks complete");
        } else {
          ctx.log.debug(summary, "readiness: checks complete");
        }
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        );
        if (failure) throw failure.reason;
      }

      const payload = {
        status: "healthy" as const,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || undefined,
        buildSha: env.APP_BUILD_SHA || undefined,
      };

      const parsed = metaReadyzOperation.output.parse(payload);
      return NextResponse.json(parsed);
    } catch (caught) {
      // A deep probe wraps its first failure and names every failing dependency.
      const error =
        caught instanceof DeepProbeFailure ? (caught.primary as Error) : caught;
      const unreachable =
        caught instanceof DeepProbeFailure
          ? { unreachable: caught.unreachable }
          : {};
      // HTTP status is primary truth for K8s: 503 = not ready
      // Log failure before returning 503 for deployment debugging
      if (error instanceof EnvValidationError) {
        logReadinessFailure(ctx, error);
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: error.meta.code,
            details: error.meta,
            ...unreachable,
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // Runtime secret validation failures (typed error from assertRuntimeSecrets)
      if (error instanceof RuntimeSecretError) {
        logReadinessFailure(ctx, error);
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: error.code,
            message: error.message,
            ...unreachable,
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // Infrastructure connectivity failures (Temporal, etc.)
      if (error instanceof InfraConnectivityError) {
        logReadinessFailure(ctx, error);
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: error.code,
            message: error.message,
            ...unreachable,
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // Unknown error - log and return generic 503
      logReadinessFailure(ctx, error as Error);
      return new NextResponse(
        JSON.stringify({
          status: "error",
          reason: "INTERNAL_ERROR",
          ...unreachable,
        }),
        {
          status: 503, // Service Unavailable - not ready
          headers: { "content-type": "application/json" },
        }
      );
    }
  }
);
