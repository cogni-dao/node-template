// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/readyz-substrate.contract`
 * Purpose: Prove the shallow/deep readiness contract for async substrate dependencies.
 * Scope: Exercises the /readyz route with isolated Temporal and scheduler-worker probes. Does not perform network or database IO.
 * Invariants: Default readiness makes zero remote calls and answers from env/secrets/config alone (story.0040); `?deep=1` probes every declared dependency concurrently and returns 503 naming each failing one.
 * Side-effects: none
 * Links: src/app/(infra)/readyz/route.ts, Cogni-DAO/cogni#1860
 * @internal
 */

import { readDeepReadiness } from "@cogni/substrate-health";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertEvmRpcConfig: vi.fn(),
  assertRuntimeSecrets: vi.fn(),
  assertSchedulerWorkerConnectivity: vi.fn(),
  assertTemporalConnectivity: vi.fn(),
  checkEvmRpcConnectivity: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  serverEnv: vi.fn(),
  setBuildInfo: vi.fn(),
  debug: vi.fn(),
  verifySystemTenant: vi.fn(),
  warn: vi.fn(),
  // Deep-probe dependencies added with the declared-dependency registry.
  streamLength: vi.fn(),
  getKnowledge: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    evmOnchainClient: {},
    paymentRailsActive: false,
    scheduleControl: {},
    serviceAccountService: {},
    runStream: {
      streamLength: (...args: unknown[]) => mocks.streamLength(...args),
    },
    knowledgeStorePort: {
      getKnowledge: (...args: unknown[]) => mocks.getKnowledge(...args),
    },
  }),
}));

vi.mock("@/bootstrap/healthchecks", () => ({
  verifySystemTenant: (...args: unknown[]) => mocks.verifySystemTenant(...args),
}));

vi.mock("@/shared/config", () => ({ getNodeId: () => "test-node" }));
vi.mock("@/bootstrap/local-readiness-preflight", () => ({
  localReadinessPreflight: () => {
    const env = mocks.serverEnv();
    mocks.assertRuntimeSecrets(env);
    mocks.assertEvmRpcConfig(env);
    return env;
  },
}));
vi.mock("@/shared/observability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  const log = {
    debug: mocks.debug,
    info: mocks.info,
    error: mocks.error,
    warn: mocks.warn,
    child: () => log,
  };
  return { ...actual, makeLogger: () => log };
});

vi.mock("@/shared/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/env")>();
  return {
    ...actual,
    serverEnv: () => mocks.serverEnv(),
  };
});

vi.mock("@/shared/env/invariants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/env/invariants")>();
  return {
    ...actual,
    assertEvmRpcConfig: (...args: unknown[]) =>
      mocks.assertEvmRpcConfig(...args),
    assertRuntimeSecrets: (...args: unknown[]) =>
      mocks.assertRuntimeSecrets(...args),
    assertSchedulerWorkerConnectivity: (...args: unknown[]) =>
      mocks.assertSchedulerWorkerConnectivity(...args),
    assertTemporalConnectivity: (...args: unknown[]) =>
      mocks.assertTemporalConnectivity(...args),
    checkEvmRpcConnectivity: (...args: unknown[]) =>
      mocks.checkEvmRpcConnectivity(...args),
  };
});

vi.mock("@/shared/observability/server/metrics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/shared/observability/server/metrics")
  >()),
  setBuildInfo: (...args: unknown[]) => mocks.setBuildInfo(...args),
}));

import { EnvValidationError } from "@/shared/env";
import {
  InfraConnectivityError,
  RuntimeSecretError,
} from "@/shared/env/invariants";

// Re-imported per test so the route's in-process system-tenant cache starts cold.
let GET: typeof import("@/app/(infra)/readyz/route").GET;

function request(path = "/readyz"): NextRequest {
  return new NextRequest(`http://localhost:3200${path}`);
}

describe("GET /readyz async substrate contract", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
    ({ GET } = await import("@/app/(infra)/readyz/route"));
    vi.clearAllMocks();
    mocks.assertEvmRpcConfig.mockReset();
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      APP_ENV: "production",
      LITELLM_BASE_URL: "http://litellm:4000",
      LITELLM_MASTER_KEY: "sk-readyz-test",
      REDIS_URL: "redis://localhost:6379",
    });
    mocks.assertTemporalConnectivity.mockResolvedValue(undefined);
    mocks.assertSchedulerWorkerConnectivity.mockResolvedValue(undefined);
    mocks.checkEvmRpcConnectivity.mockResolvedValue({ ok: true });
    mocks.verifySystemTenant.mockResolvedValue(undefined);
    // Always-declared deep probes resolve healthy by default.
    mocks.streamLength.mockResolvedValue(0);
    mocks.getKnowledge.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ model_name: "test-model" }] }),
    });
    vi.stubGlobal("fetch", (...args: unknown[]) => mocks.fetch(...args));
  });

  it("returns 503 when the mandatory RPC secret is missing", async () => {
    mocks.assertEvmRpcConfig.mockImplementation(() => {
      throw new RuntimeSecretError("EVM_RPC_URL is required");
    });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "MISSING_RUNTIME_SECRET",
      message: "EVM_RPC_URL is required",
    });
    expect(mocks.checkEvmRpcConnectivity).not.toHaveBeenCalled();
  });

  it("forces a live RPC read and returns 503 when the deep probe cannot reach Base", async () => {
    mocks.checkEvmRpcConnectivity.mockResolvedValue({
      ok: false,
      source: "live",
      errorMessage: "RPC timeout",
    });

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "EVM RPC connectivity check failed: RPC timeout",
    });
    expect(mocks.checkEvmRpcConnectivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ APP_ENV: "production" }),
      { forceLive: true },
    );
    expect(mocks.error).toHaveBeenCalledWith(
      { errorCode: "INFRA_UNREACHABLE" },
      "readiness check failed",
    );
  });

  it("records successful deep RPC proof", async () => {
    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(200);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.deep.complete",
        checks: expect.objectContaining({
          "evm-rpc": expect.objectContaining({ status: "ok" }),
        }),
      }),
      "deep readiness: checks complete",
    );
  });

  it("returns 503 from the deep probe when Temporal is unavailable", async () => {
    mocks.assertTemporalConnectivity.mockRejectedValue(
      new InfraConnectivityError("Temporal is unavailable"),
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "Temporal is unavailable",
      unreachable: ["temporal"],
    });
    // Checks are independent: scheduler-worker still ran, and the body names only Temporal.
    expect(mocks.assertSchedulerWorkerConnectivity).toHaveBeenCalledTimes(1);
    expect(mocks.verifySystemTenant).toHaveBeenCalledTimes(1);
  });

  it("returns 503 from the deep probe when scheduler-worker is unavailable", async () => {
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("scheduler-worker is unavailable"),
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "scheduler-worker is unavailable",
    });
    expect(mocks.assertTemporalConnectivity).toHaveBeenCalledOnce();
    expect(mocks.verifySystemTenant).toHaveBeenCalledTimes(1);
  });

  it("default readiness still returns 503 when runtime secrets are missing, before any check runs", async () => {
    mocks.assertRuntimeSecrets.mockImplementationOnce(() => {
      throw new RuntimeSecretError("secret missing");
    });
    mocks.verifySystemTenant.mockRejectedValue(new Error("pg down"));

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "MISSING_RUNTIME_SECRET",
      message: "secret missing",
    });
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });

  it("default readiness still returns 503 on invalid environment, before any check runs", async () => {
    mocks.serverEnv.mockImplementationOnce(() => {
      throw new EnvValidationError({
        code: "INVALID_ENV",
        missing: ["DATABASE_URL"],
        invalid: [],
      });
    });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });

  it("names every failing dependency in the deep 503, keeping reason and message from the first", async () => {
    mocks.checkEvmRpcConnectivity.mockResolvedValue({
      ok: false,
      source: "live",
      errorMessage: "upstream 429",
    });
    mocks.assertTemporalConnectivity.mockRejectedValue(
      new InfraConnectivityError("Temporal is unavailable"),
    );
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("worker is unavailable"),
    );
    mocks.verifySystemTenant.mockRejectedValue(new Error("pg down"));

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "EVM RPC connectivity check failed: upstream 429",
      unreachable: ["evm-rpc", "temporal", "scheduler-worker", "postgres"],
      checks: expect.objectContaining({
        "evm-rpc": expect.objectContaining({ status: "failed" }),
        postgres: expect.objectContaining({ status: "failed" }),
        redis: expect.objectContaining({ status: "ok" }),
      }),
      buildSha: "readyz-contract-sha",
    });
  });

  it("names postgres alone when only the database is down", async () => {
    mocks.verifySystemTenant.mockRejectedValue(new Error("pg down"));

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      unreachable: ["postgres"],
    });
  });

  it("lists a check that exceeds the deep budget in unreachable and answers at the budget", async () => {
    vi.useFakeTimers();
    mocks.assertSchedulerWorkerConnectivity.mockReturnValue(
      new Promise(() => {}),
    );

    const pending = GET(request("/readyz?deep=1"));
    await vi.advanceTimersByTimeAsync(2999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "scheduler-worker check exceeded 3000ms budget",
      unreachable: ["scheduler-worker"],
      checks: expect.objectContaining({
        "scheduler-worker": expect.objectContaining({ status: "failed" }),
      }),
      buildSha: "readyz-contract-sha",
    });
  });

  it("serves a deep body the shared reader judges per dependency (story.0029)", async () => {
    const healthy = await GET(request("/readyz?deep=1"));
    const healthyBody = await healthy.json();
    expect(healthyBody.checks.postgres.status).toBe("ok");
    expect(
      readDeepReadiness(healthy.status, healthyBody).dependencyState(
        "postgres",
      ),
    ).toBe("reached");

    // An unrelated dependency down must not hide that Postgres answered.
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("worker is unavailable"),
    );
    const degraded = await GET(request("/readyz?deep=1"));
    const reading = readDeepReadiness(degraded.status, await degraded.json());
    expect(degraded.status).toBe(503);
    expect(reading.buildSha).toBe("readyz-contract-sha");
    expect(reading.dependencyState("postgres")).toBe("reached");
    expect(reading.dependencyState("scheduler-worker")).toBe("unreached");
  });

  it("bounds a hung deep check and still names the others", async () => {
    vi.useFakeTimers();
    mocks.assertTemporalConnectivity.mockReturnValue(new Promise(() => {}));
    mocks.verifySystemTenant.mockRejectedValue(new Error("pg down"));

    const pending = GET(request("/readyz?deep=1"));
    await vi.advanceTimersByTimeAsync(3000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      unreachable: ["temporal", "postgres"],
    });
  });

  it("carries no unreachable field on a healthy deep 200, a config 503, or the default path", async () => {
    expect(
      await (await GET(request("/readyz?deep=1"))).json(),
    ).not.toHaveProperty("unreachable");
    mocks.verifySystemTenant.mockRejectedValue(new Error("pg down"));
    const shallow = await GET(request());
    expect(shallow.status).toBe(200);
    expect(await shallow.json()).not.toHaveProperty("unreachable");
    mocks.assertRuntimeSecrets.mockImplementationOnce(() => {
      throw new RuntimeSecretError("secret missing");
    });
    const deepConfig = await GET(request("/readyz?deep=1"));
    expect(deepConfig.status).toBe(503);
    expect(await deepConfig.json()).not.toHaveProperty("unreachable");
  });

  it("keeps the deep probe uncached and unbounded by the default budgets", async () => {
    vi.useFakeTimers();
    mocks.assertTemporalConnectivity.mockReturnValue(
      new Promise((resolve) => setTimeout(resolve, 2500)),
    );

    const pending = GET(request("/readyz?deep=1"));
    await vi.advanceTimersByTimeAsync(2500);
    expect((await pending).status).toBe(200);
    expect((await GET(request("/readyz?deep=1"))).status).toBe(200);

    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).toHaveBeenCalledTimes(2);
  });

  it("names redis in the deep 503 when the run-stream is unreachable", async () => {
    mocks.streamLength.mockRejectedValue(new Error("Redis connection refused"));

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      unreachable: ["redis"],
    });
  });

  it("names litellm-gateway in the deep 503 when the gateway is unreachable", async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      unreachable: ["litellm-gateway"],
    });
  });

  it("fails the litellm-gateway probe when the catalog is empty", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      unreachable: ["litellm-gateway"],
    });
  });

  it("probes Doltgres only when DOLTGRES_URL is declared, naming it on failure", async () => {
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      APP_ENV: "production",
      LITELLM_BASE_URL: "http://litellm:4000",
      LITELLM_MASTER_KEY: "sk-readyz-test",
      REDIS_URL: "redis://localhost:6379",
      DOLTGRES_URL: "postgresql://doltgres:5432/knowledge",
    });
    mocks.getKnowledge.mockRejectedValue(
      new Error("doltgres connection refused"),
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      unreachable: ["doltgres"],
    });
    expect(mocks.getKnowledge).toHaveBeenCalledTimes(1);
  });

  it("passes the deep probe when declared Doltgres is reachable", async () => {
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      APP_ENV: "production",
      LITELLM_BASE_URL: "http://litellm:4000",
      LITELLM_MASTER_KEY: "sk-readyz-test",
      REDIS_URL: "redis://localhost:6379",
      DOLTGRES_URL: "postgresql://doltgres:5432/knowledge",
    });

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(200);
    expect(mocks.getKnowledge).toHaveBeenCalledTimes(1);
  });

  it("skips the Doltgres probe when DOLTGRES_URL is unset", async () => {
    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(200);
    expect(mocks.getKnowledge).not.toHaveBeenCalled();
  });

  it("names redis, litellm-gateway and doltgres in order when all three fail at once", async () => {
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      APP_ENV: "production",
      LITELLM_BASE_URL: "http://litellm:4000",
      LITELLM_MASTER_KEY: "sk-readyz-test",
      REDIS_URL: "redis://localhost:6379",
      DOLTGRES_URL: "postgresql://doltgres:5432/knowledge",
    });
    mocks.streamLength.mockRejectedValue(new Error("Redis connection refused"));
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    mocks.getKnowledge.mockRejectedValue(new Error("doltgres down"));

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    const body = await response.json();
    // Order is fixed by the registry: the existing four pass, then the three new
    // deps fail in registry order; reason/message come from the first failure (redis).
    expect(body).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      unreachable: ["redis", "litellm-gateway", "doltgres"],
    });
    expect(body.message).toContain("Redis run-stream unreachable");
  });

  it("emits a per-dependency deep-readiness summary naming every probed dependency ok", async () => {
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      APP_ENV: "production",
      LITELLM_BASE_URL: "http://litellm:4000",
      LITELLM_MASTER_KEY: "sk-readyz-test",
      REDIS_URL: "redis://localhost:6379",
      DOLTGRES_URL: "postgresql://doltgres:5432/knowledge",
    });

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(200);
    // The summary is the per-dependency Loki evidence: which declared deps were
    // actually probed and proven reachable this request.
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.deep.complete",
        unreachable: [],
        checks: expect.objectContaining({
          "evm-rpc": { status: "ok", durationMs: expect.any(Number) },
          temporal: { status: "ok", durationMs: expect.any(Number) },
          "scheduler-worker": {
            status: "ok",
            durationMs: expect.any(Number),
          },
          postgres: { status: "ok", durationMs: expect.any(Number) },
          redis: { status: "ok", durationMs: expect.any(Number) },
          "litellm-gateway": {
            status: "ok",
            durationMs: expect.any(Number),
          },
          doltgres: { status: "ok", durationMs: expect.any(Number) },
        }),
      }),
      "deep readiness: checks complete",
    );
  });

  it("marks a failing dependency failed in the deep-readiness summary", async () => {
    mocks.streamLength.mockRejectedValue(new Error("Redis connection refused"));

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.deep.complete",
        unreachable: ["redis"],
        checks: expect.objectContaining({
          redis: { status: "failed", durationMs: expect.any(Number) },
          "litellm-gateway": {
            status: "ok",
            durationMs: expect.any(Number),
          },
        }),
      }),
      "deep readiness: checks complete",
    );
  });
  it("default path makes zero remote calls, even when every dependency would stall (story.0040)", async () => {
    const never = new Promise<never>(() => undefined);
    mocks.checkEvmRpcConnectivity.mockReturnValue(never);
    mocks.assertTemporalConnectivity.mockReturnValue(never);
    mocks.assertSchedulerWorkerConnectivity.mockReturnValue(never);
    mocks.verifySystemTenant.mockReturnValue(never);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy",
      buildSha: "readyz-contract-sha",
    });
    expect(mocks.checkEvmRpcConnectivity).not.toHaveBeenCalled();
    expect(mocks.assertTemporalConnectivity).not.toHaveBeenCalled();
    expect(mocks.assertSchedulerWorkerConnectivity).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });
});
