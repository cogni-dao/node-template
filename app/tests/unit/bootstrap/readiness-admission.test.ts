// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Exercises the actual readiness envelope and qualification without remote services. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preflight: vi.fn(),
  getContainer: vi.fn(),
  getNodeId: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@/bootstrap/local-readiness-preflight", () => ({
  localReadinessPreflight: mocks.preflight,
}));
vi.mock("@/bootstrap/container", () => ({ getContainer: mocks.getContainer }));
vi.mock("@/shared/config", () => ({ getNodeId: mocks.getNodeId }));
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    async start() {}
  },
}));
vi.mock("@/bootstrap/healthchecks", () => ({
  verifySystemTenant: mocks.verify,
}));
vi.mock("@/app/(infra)/readyz/readyz-probes", () => ({
  buildDeepChecks: vi.fn(() => []),
  deepRuntime: () => ({
    log: () => {},
    budgetMs: 3000,
    timeoutError: () => new Error("timeout"),
  }),
}));

import { GET } from "@/app/(infra)/readyz/route";
import {
  resetStartupAssertionsForTest,
  startSystemTenantAssertionOnBoot,
} from "@/bootstrap/startup-assertions";
import { register } from "@/instrumentation.node";
import type { ServiceAccountService } from "@/ports";
import { RuntimeSecretError } from "@/shared/env/invariants";
import { EnvValidationError } from "@/shared/env/server-env";
import { createLokiPushStream } from "@/shared/observability/server/loki-push-stream";

type LokiGlobal = typeof globalThis & {
  __cogniLokiPushInit?: boolean;
  __cogniLokiPushStream?: ReturnType<typeof createLokiPushStream>;
};
const globalLoki = globalThis as LokiGlobal;
const request = () =>
  new Request("http://localhost/readyz", {
    headers: { "x-request-id": "ready-123" },
  });
beforeEach(() => {
  vi.clearAllMocks();
  resetStartupAssertionsForTest();
  mocks.preflight.mockReturnValue({ APP_BUILD_SHA: "test-sha" });
  mocks.getNodeId.mockReturnValue("node-123");
});
afterEach(() => {
  delete globalLoki.__cogniLokiPushInit;
  delete globalLoki.__cogniLokiPushStream;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("readiness admission", () => {
  it("keeps the real envelope local, timed and attributed across the old Loki threshold", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    const stream = createLokiPushStream({
      env: { LOKI_PUSH_URL: "https://logs.invalid" },
      fetchFn,
    });
    globalLoki.__cogniLokiPushInit = true;
    globalLoki.__cogniLokiPushStream = stream;
    for (let i = 0; i < 499; i++) stream?.write(`{"i":${i}}\n`);
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "production");
    let time = 10;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    mocks.getNodeId.mockImplementation(() => {
      time += 37;
      return "node-123";
    });
    expect((await GET(request())).status).toBe(200);
    expect((await GET(request())).status).toBe(200);
    mocks.preflight.mockImplementation(() => {
      throw new RuntimeSecretError("missing secret");
    });
    expect((await GET(request())).status).toBe(503);
    expect(mocks.getContainer).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    stream?.flushNow();
    const body = JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string);
    const logs = body.streams[0].values.map((entry: [string, string]) =>
      JSON.parse(entry[1]),
    );
    const complete = logs.filter(
      (entry: { msg?: string }) => entry.msg === "request complete",
    );
    expect(complete).toHaveLength(3);
    expect(complete[0]).toMatchObject({
      reqId: "ready-123",
      nodeId: "node-123",
      durationMs: 37,
      status: 200,
    });
    expect(complete[2]).toMatchObject({
      reqId: "ready-123",
      nodeId: "node-123",
      durationMs: 37,
      status: 503,
    });
  });
  it("the real local preflight refuses missing configuration without network IO", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("DATABASE_URL", "");
    const fetchFn = vi.spyOn(globalThis, "fetch");
    const { localReadinessPreflight } = await vi.importActual<
      typeof import("@/bootstrap/local-readiness-preflight")
    >("@/bootstrap/local-readiness-preflight");
    expect(() => localReadinessPreflight()).toThrow(EnvValidationError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("reports invalid logging configuration through the real timed envelope", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PINO_LOG_LEVEL", "bogus");
    vi.stubEnv("LITELLM_MASTER_KEY", "test-key");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://app_user:password@localhost:5432/db",
    );
    vi.stubEnv(
      "DATABASE_SERVICE_URL",
      "postgresql://app_service:password@localhost:5432/db",
    );
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("SCHEDULER_API_TOKEN", "b".repeat(32));
    vi.stubEnv("BILLING_INGEST_TOKEN", "c".repeat(32));
    const { localReadinessPreflight } = await vi.importActual<
      typeof import("@/bootstrap/local-readiness-preflight")
    >("@/bootstrap/local-readiness-preflight");
    mocks.preflight.mockImplementation(localReadinessPreflight);
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    const stream = createLokiPushStream({
      env: { LOKI_PUSH_URL: "https://logs.invalid" },
      fetchFn,
    });
    globalLoki.__cogniLokiPushInit = true;
    globalLoki.__cogniLokiPushStream = stream;
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      reason: "INVALID_ENV",
      details: { missing: [], invalid: ["PINO_LOG_LEVEL"] },
    });
    expect(mocks.getContainer).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    stream?.flushNow();
    const payload = JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string);
    const complete = payload.streams[0].values
      .map((entry: [string, string]) => JSON.parse(entry[1]))
      .filter((entry: { msg?: string }) => entry.msg === "request complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({
      reqId: "ready-123",
      status: 503,
      durationMs: expect.any(Number),
    });
  });
  it("returns structured 503 for typed local refusal", async () => {
    mocks.preflight.mockImplementation(() => {
      throw new RuntimeSecretError("missing secret");
    });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      reason: "MISSING_RUNTIME_SECRET",
    });
    expect(mocks.getContainer).not.toHaveBeenCalled();
  });
  it("native register waits for mandatory qualification", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("LITELLM_BASE_URL", "");
    mocks.getContainer.mockReturnValue({ serviceAccountService: {} });
    let resolve!: () => void;
    mocks.verify.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    let finished = false;
    const registration = register().then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(mocks.verify).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    resolve();
    await registration;
    expect(finished).toBe(true);
  });
  it("native register permits diagnostic startup only for typed local errors", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("APP_ENV", "test");
    mocks.preflight.mockImplementation(() => {
      throw new RuntimeSecretError("missing");
    });
    await register();
    expect(mocks.getContainer).not.toHaveBeenCalled();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    mocks.preflight.mockImplementation(() => {
      throw new Error("repo invariant");
    });
    await expect(register()).rejects.toThrow("repo invariant");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("exits and rejects when container construction fails", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    mocks.getContainer.mockImplementation(() => {
      throw new Error("container failed");
    });
    await expect(register()).rejects.toThrow("container failed");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("emits safe fatal metadata without serializing the original error", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const sentinel = "PRIVATE_SENTINEL_93d1";
    const original = Object.assign(
      new Error(sentinel, { cause: new Error(sentinel) }),
      {
        headers: { authorization: sentinel },
        url: `https://example.invalid/${sentinel}`,
      },
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    mocks.getContainer.mockImplementation(() => {
      throw original;
    });
    await expect(register()).rejects.toBe(original);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(output).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain(sentinel);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      errorCode: "STARTUP_FATAL",
      phase: "initialization",
    });
  });
  it("terminates and retains the original error if fatal logging fails", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const original = new Error("original");
    vi.spyOn(process.stdout, "write").mockImplementation((() => {
      throw new Error("logger failed");
    }) as typeof process.stdout.write);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    mocks.getContainer.mockImplementation(() => {
      throw original;
    });
    await expect(register()).rejects.toBe(original);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("does not classify typed container errors as local refusal", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    mocks.getContainer.mockImplementation(() => {
      throw new RuntimeSecretError("construction failure");
    });
    await expect(register()).rejects.toThrow("construction failure");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("native register rejects a failed remote qualification", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("VITEST", "false");
    mocks.getContainer.mockReturnValue({ serviceAccountService: {} });
    mocks.verify.mockRejectedValue(new Error("tenant unavailable"));
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    await expect(register()).rejects.toThrow("tenant unavailable");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("retains pending and rejected qualification when exit returns", async () => {
    let reject!: (error: Error) => void;
    mocks.verify.mockReturnValue(
      new Promise((_resolve, rejectFn) => {
        reject = rejectFn;
      }),
    );
    const exit = vi.fn();
    const service = {} as ServiceAccountService;
    const first = startSystemTenantAssertionOnBoot(service, {
      force: true,
      exit,
    });
    expect(
      startSystemTenantAssertionOnBoot(service, { force: true, exit }),
    ).toBe(first);
    const failure = expect(first).rejects.toThrow("remote failure");
    reject(new Error("remote failure"));
    await failure;
    await expect(
      startSystemTenantAssertionOnBoot(service, { force: true, exit }),
    ).rejects.toThrow("remote failure");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
