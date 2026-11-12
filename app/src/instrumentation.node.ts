// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@instrumentation/node`
 * Purpose: Next.js instrumentation hook — once-per-process startup orchestration.
 * Scope: Initialize OTel SDK and run preflight checks. Does NOT export SDK instance or run during build.
 * Invariants:
 *   - OTel init happens ONLY in this file (not container module-load)
 *   - Must await sdk.start() and hard-fail in non-dev if startup fails
 *   - Service name via OTEL_SERVICE_NAME env var (not constructor option)
 *   - No auto-instrumentation for P0 (explicit spans only)
 *   - P0 uses a no-op span processor and no OTel log exporter (IDs + Langfuse only)
 * Side-effects: IO (OTel SDK global state initialization)
 * Notes: Next.js calls register() once per Node.js process on startup.
 * Links: AI_SETUP_SPEC.md, bootstrap/otel.ts for span helpers
 * @public
 */

import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import pino from "pino";

let sdk: NodeSDK | null = null;
let sdkAttempt: Promise<void> | undefined;

/** The existing startup Pino configuration also serves fatal diagnostics. */
function makeBootLogger() {
  return pino(
    {
      base: {
        app: "cogni-template",
        // biome-ignore lint/style/noProcessEnv: startup logger before config framework
        service: process.env.SERVICE_NAME ?? "app",
      },
      messageKey: "msg",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    process.stdout,
  );
}

/**
 * Emit one structured startup log with the image build SHA so grafana-based
 * agents can correlate a running pod to its PR/commit. Self-contained pino
 * instance because the shared logger sits behind the bootstrap/container
 * wiring, which dep-cruiser forbids instrumentation.ts from importing.
 */
function logAppStarted(): void {
  // biome-ignore lint/style/noProcessEnv: startup log emitted before config framework
  if (process.env.APP_ENV === "test" || process.env.VITEST === "true") {
    return;
  }
  const bootLogger = makeBootLogger();
  // biome-ignore lint/style/noProcessEnv: build-time plumbing injected via Dockerfile ARG
  const buildSha = process.env.APP_BUILD_SHA;
  if (buildSha) {
    bootLogger.info({ buildSha }, "app started");
  } else {
    // No fallback string — emit at warn so missing/forgotten BUILD_SHA is visible
    // rather than cloaked behind a placeholder.
    bootLogger.warn(
      { buildSha: null },
      "app started (APP_BUILD_SHA unset — check CI --build-arg BUILD_SHA)",
    );
  }
}

/**
 * Initialize OTel SDK with P0 configuration.
 * Shared between Next.js instrumentation and test setup.
 *
 * Per AI_SETUP_SPEC.md:
 * - Service name via OTEL_SERVICE_NAME env var (SDK reads it automatically)
 * - No auto-instrumentation for P0 (explicit spans only)
 * - No exporter for P0 (IDs + Langfuse only; no Tempo/Grafana traces yet)
 *
 * @param options - Optional configuration
 * @param options.failOnError - Whether to throw on startup failure (default: !isDev)
 * @returns true if SDK started successfully, false otherwise
 */
export async function initOtelSdk(options?: {
  failOnError?: boolean;
}): Promise<boolean> {
  // Keep failure as well as success: a degraded caller cannot mask a failed
  // attempt from a later caller that requires telemetry initialization.
  sdkAttempt ??= (async () => {
    const candidate = new NodeSDK({
      instrumentations: [],
      spanProcessors: [new tracing.NoopSpanProcessor()],
      logRecordProcessors: [],
    });
    await candidate.start();
    sdk = candidate;
  })();

  try {
    await sdkAttempt;
    return true;
  } catch (error) {
    // biome-ignore lint/style/noProcessEnv: NODE_ENV is standard Next.js runtime env
    const shouldFail =
      options?.failOnError ?? process.env.NODE_ENV !== "development";
    if (shouldFail) throw error;
    try {
      makeBootLogger().warn(
        { errorCode: "OTEL_INIT_FAILED", phase: "initialization" },
        "telemetry initialization failed",
      );
    } catch {
      // Degraded callers do not let diagnostics replace the initialization result.
    }
    return false;
  }
}

/** Fail explicitly: production Next catches rejected preparation without exiting. */
function fatalStartup(
  error: unknown,
  phase: "initialization" | "startup_log",
): never {
  try {
    makeBootLogger().error(
      { errorCode: "STARTUP_FATAL", phase },
      "fatal startup failure",
    );
  } catch {
    // Logging must never prevent fatal termination or replace the original error.
  }
  process.exit(1);
  throw error;
}

/**
 * Next.js instrumentation hook - called once per Node.js process.
 * Awaits local preflight and mandatory tenant qualification before traffic admission.
 */
export async function register(): Promise<void> {
  // Only initialize in Node.js runtime (allowlist, not denylist)
  // biome-ignore lint/style/noProcessEnv: NEXT_RUNTIME is set by Next.js, no config file
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  let qualification: Promise<void> | undefined;
  try {
    await initOtelSdk();

    // Only errors from this synchronous local phase permit diagnostic startup.
    const { localReadinessPreflight } = await import(
      "./bootstrap/local-readiness-preflight"
    );
    const { EnvValidationError } = await import("./shared/env/server-env");
    const { RuntimeSecretError } = await import("./shared/env/invariants");
    let localConfigValid = true;
    try {
      localReadinessPreflight();
    } catch (error) {
      if (
        !(
          error instanceof EnvValidationError ||
          error instanceof RuntimeSecretError
        )
      )
        throw error;
      localConfigValid = false;
    }
    if (localConfigValid) {
      const { getContainer } = await import("./bootstrap/container");
      const { startSystemTenantAssertionOnBoot } = await import(
        "./bootstrap/startup-assertions"
      );
      qualification = startSystemTenantAssertionOnBoot(
        getContainer().serviceAccountService,
      );
    }
  } catch (error) {
    fatalStartup(error, "initialization");
  }

  // The qualification owner logs and exits on rejection; do not exit twice.
  await qualification;
  try {
    logAppStarted();
  } catch (error) {
    fatalStartup(error, "startup_log");
  }

  // This existing process owns the one package maintenance lease. No workflow or additional DB pool.
  const { maintenanceTick, maintainEnrollmentDelivery } = await import("@cogni/agent-grants/enrollment");
  const { maintainRequesterCustody } = await import("@cogni/agent-grants/enrollment-requester");
  const { getServiceDb } = await import(
    "@/adapters/server/db/drizzle.service-client"
  );
  const maintenanceLogger = pino({
    base: { component: "agent-authority-maintenance" },
  });
  let maintenanceRunning = false;
  const tick = async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      const outcome = await maintenanceTick(
        getServiceDb()
          .$client as unknown as import("@cogni/agent-grants/credentials").CredentialSql,
        async (tx) => {
          await maintainRequesterCustody(tx);
          await maintainEnrollmentDelivery(tx);
        }
      );
      if (outcome.due)
        maintenanceLogger.warn(
          {
            event: "agent.authority.maintenance_backlog",
            processed: outcome.processed,
          },
          "agent.authority.maintenance_backlog"
        );
    } catch {
      maintenanceLogger.warn(
        { event: "agent.authority.maintenance_unavailable" },
        "agent.authority.maintenance_unavailable"
      );
    } finally {
      maintenanceRunning = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 60000);
  timer.unref();
  const stop = () => clearInterval(timer);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  // Dev mode (not test): warn if LiteLLM has stale test config from a previous session.
  // Keep this advisory check independent of mandatory qualification.
  // biome-ignore lint/style/noProcessEnv: startup check before config framework
  if (process.env.APP_ENV !== "test") {
    (async () => {
      // biome-ignore lint/style/noProcessEnv: startup check before config framework
      const baseUrl = process.env.LITELLM_BASE_URL;
      // biome-ignore lint/style/noProcessEnv: startup check before config framework
      const masterKey = process.env.LITELLM_MASTER_KEY;
      if (!baseUrl || !masterKey) return;
      try {
        const res = await fetch(`${baseUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${masterKey}` },
          signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        const ids = (data.data ?? []).map((m) => m.id);
        if (ids.includes("test-model")) {
          // biome-ignore lint/suspicious/noConsole: startup warning before logging
          console.warn(
            [
              "",
              "  ╔══════════════════════════════════════════════════════════════╗",
              "  ║  WARNING: LiteLLM is loaded with TEST config (test-model)  ║",
              "  ║  dev:stack expects prod config (litellm.config.yaml).      ║",
              "  ║                                                            ║",
              "  ║  LLM calls will route to mock-openai-api, not real LLMs.  ║",
              "  ║                                                            ║",
              "  ║  Fix: docker compose down litellm && pnpm dev:stack        ║",
              "  ╚══════════════════════════════════════════════════════════════╝",
              "",
            ].join("\n"),
          );
        }
      } catch {
        // Non-fatal: LiteLLM might not be up yet
      }
    })().catch(() => {});
  }
}

/**
 * Get the initialized SDK instance.
 * Returns null if SDK not initialized (Edge runtime or initialization failed).
 * @internal - Use withRootSpan() from bootstrap/otel.ts instead
 */
export function getOtelSdk(): NodeSDK | null {
  return sdk;
}
