// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeepProbeFailure,
  type DeepRuntime,
  findUnclassifiedSubstrateKeys,
  probeKnowledgePlane,
  probeLiteLlmGateway,
  probeRedisStream,
  readDeepReadiness,
  runDeepChecks,
  serveReadyz,
} from "../src/index.ts";

const wrapError = (message: string) => new Error(message);

function runtime(): { rt: DeepRuntime; logs: Array<[Record<string, unknown>, string]> } {
  const logs: Array<[Record<string, unknown>, string]> = [];
  return {
    logs,
    rt: {
      log: (fields, message) => logs.push([fields, message]),
      timeoutError: (dependency, budgetMs) =>
        new Error(`${dependency} check exceeded ${budgetMs}ms budget`),
      budgetMs: 50,
    },
  };
}

describe("runDeepChecks", () => {
  it("emits one per-dependency summary and resolves when all pass", async () => {
    const { rt, logs } = runtime();
    await runDeepChecks(
      [
        ["postgres", async () => undefined],
        ["redis", async () => undefined],
      ],
      rt
    );
    expect(logs).toHaveLength(1);
    const [fields, message] = logs[0]!;
    expect(message).toBe("deep readiness: checks complete");
    expect(fields.event).toBe("substrate.deep.complete");
    expect(fields.unreachable).toEqual([]);
    expect((fields.checks as Record<string, { status: string }>).postgres.status).toBe("ok");
    expect((fields.checks as Record<string, { status: string }>).redis.status).toBe("ok");
  });

  it("throws DeepProbeFailure naming every failing dep in order, primary = first", async () => {
    const { rt, logs } = runtime();
    const boom = new Error("redis down");
    await expect(
      runDeepChecks(
        [
          ["postgres", async () => undefined],
          ["redis", async () => Promise.reject(boom)],
          ["doltgres", async () => Promise.reject(new Error("dolt down"))],
        ],
        rt
      )
    ).rejects.toMatchObject({ unreachable: ["redis", "doltgres"], primary: boom });
    expect((logs[0]![0].checks as Record<string, { status: string }>).redis.status).toBe("failed");
    expect(logs[0]![0].unreachable).toEqual(["redis", "doltgres"]);
  });

  it("returns the checks map on pass and carries it on the failure", async () => {
    const { rt } = runtime();
    const checks = await runDeepChecks([["postgres", async () => undefined]], rt);
    expect(checks.postgres?.status).toBe("ok");
    const failure = await runDeepChecks(
      [
        ["postgres", async () => undefined],
        ["scheduler-worker", async () => Promise.reject(new Error("down"))],
      ],
      rt
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeepProbeFailure);
    expect((failure as DeepProbeFailure).checks.postgres?.status).toBe("ok");
    expect((failure as DeepProbeFailure).checks["scheduler-worker"]?.status).toBe("failed");
  });

  it("counts a check that exceeds the budget as failed via timeoutError", async () => {
    const { rt } = runtime();
    await expect(
      runDeepChecks([["temporal", () => new Promise(() => {})]], rt)
    ).rejects.toBeInstanceOf(DeepProbeFailure);
  });
});

describe("probe factories keep `this` bound (B4 regression)", () => {
  class RealRedis {
    public lastKey = "";
    async streamLength(key: string): Promise<number> {
      this.lastKey = key; // throws if `this` is undefined (detached method)
      return 0;
    }
  }
  class RealKnowledge {
    public lastId = "";
    async getKnowledge(id: string): Promise<unknown> {
      this.lastId = id;
      return null;
    }
  }

  it("probeRedisStream calls the method on the instance, not detached", async () => {
    const redis = new RealRedis();
    await probeRedisStream(redis, "readyz:probe", { wrapError })();
    expect(redis.lastKey).toBe("readyz:probe");
  });

  it("probeKnowledgePlane calls the method on the instance, not detached", async () => {
    const kb = new RealKnowledge();
    await probeKnowledgePlane(kb, "readyz-probe-id", { wrapError })();
    expect(kb.lastId).toBe("readyz-probe-id");
  });

  it("wraps a port failure in the injected error", async () => {
    const port = {
      streamLength: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    await expect(probeRedisStream(port, "k", { wrapError })()).rejects.toThrow(
      /Redis run-stream unreachable: ECONNREFUSED/
    );
  });
});

describe("probeLiteLlmGateway", () => {
  afterEach(() => vi.restoreAllMocks());

  const cfg = { baseUrl: "http://litellm:4000", apiKey: "sk-x", budgetMs: 100 };

  it("accepts a {data:[...]} catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })
    );
    await expect(probeLiteLlmGateway(cfg, { wrapError })()).resolves.toBeUndefined();
  });

  it("accepts a raw array and a {models:[...]} catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "m" }]), { status: 200 })
    );
    await expect(probeLiteLlmGateway(cfg, { wrapError })()).resolves.toBeUndefined();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ models: [{ id: "m" }] }), { status: 200 })
    );
    await expect(probeLiteLlmGateway(cfg, { wrapError })()).resolves.toBeUndefined();
  });

  it("fails on empty catalog and non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    await expect(probeLiteLlmGateway(cfg, { wrapError })()).rejects.toThrow(/no models/);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 502 }));
    await expect(probeLiteLlmGateway(cfg, { wrapError })()).rejects.toThrow(/returned 502/);
  });
});

describe("findUnclassifiedSubstrateKeys (drift guard)", () => {
  const opts = {
    classifiedKeys: ["DATABASE_URL", "REDIS_URL"],
    allowlist: ["APP_BASE_URL"],
  };
  it("passes when every *_URL/*_ADDRESS key is classified or allowlisted", () => {
    expect(
      findUnclassifiedSubstrateKeys(["DATABASE_URL", "REDIS_URL", "APP_BASE_URL", "LOG_LEVEL"], opts)
    ).toEqual([]);
  });
  it("reports a new unclassified substrate key", () => {
    expect(findUnclassifiedSubstrateKeys(["NEW_SERVICE_URL"], opts)).toEqual([
      "NEW_SERVICE_URL",
    ]);
  });
});

describe("readDeepReadiness", () => {
  const ok = { status: "ok", durationMs: 3 };
  const failed = { status: "failed", durationMs: 3000 };

  it("reads a 503 per dependency: ok is reached, failed is unreached, absent is na", () => {
    const r = readDeepReadiness(503, {
      status: "error",
      reason: "INFRA_UNREACHABLE",
      unreachable: ["scheduler-worker"],
      checks: { postgres: ok, "scheduler-worker": failed },
      buildSha: "abc",
    });
    expect(r.buildSha).toBe("abc");
    expect(r.healthy).toBe(false);
    expect(r.dependencyState("postgres")).toBe("reached");
    expect(r.dependencyState("scheduler-worker")).toBe("unreached");
    expect(r.dependencyState("doltgres")).toBe("na");
  });

  it("reads a 200 with checks as reached for probed names and na for the rest", () => {
    const r = readDeepReadiness(200, { status: "healthy", checks: { postgres: ok }, buildSha: "abc" });
    expect(r.dependencyState("postgres")).toBe("reached");
    expect(r.dependencyState("redis")).toBe("na");
  });

  it("never treats an aggregate 200 without checks as evidence about one dependency", () => {
    const r = readDeepReadiness(200, { status: "healthy", buildSha: "abc" });
    expect(r.healthy).toBe(true);
    expect(r.dependencyState("postgres")).toBe("unknown");
  });

  it("reads an older 503 by its unreachable list only", () => {
    const r = readDeepReadiness(503, { status: "error", unreachable: ["redis"] });
    expect(r.dependencyState("redis")).toBe("unreached");
    expect(r.dependencyState("postgres")).toBe("unknown");
    expect(r.buildSha).toBeUndefined();
  });

  it("reads a config 503, another status, a 200 with a failed check, or junk as unknown", () => {
    expect(readDeepReadiness(503, { status: "error", reason: "ENV_INVALID" }).dependencyState("postgres")).toBe("unknown");
    expect(readDeepReadiness(502, { status: "error", checks: { postgres: ok } }).dependencyState("postgres")).toBe("unknown");
    expect(readDeepReadiness(200, { status: "healthy", checks: { postgres: failed } }).dependencyState("postgres")).toBe("unknown");
    expect(readDeepReadiness(200, "<html>").dependencyState("postgres")).toBe("unknown");
    expect(readDeepReadiness(503, { status: "error", checks: { postgres: "ok" } }).dependencyState("postgres")).toBe("unknown");
    expect(readDeepReadiness(200, { status: "healthy", checks: {} }).dependencyState("toString")).toBe("na");
  });
});

describe("serveReadyz", () => {
  const describeError = (error: unknown) => ({
    reason: "INFRA_UNREACHABLE",
    message: error instanceof Error ? error.message : String(error),
  });

  it("default path runs only the local check: no deep check is built or run", async () => {
    const { rt } = runtime();
    const deepChecks = vi.fn(() => [["postgres", async () => undefined]] as const);
    const res = await serveReadyz({
      deep: false,
      local: () => ({ buildSha: "abc", version: "1" }),
      deepChecks,
      runtime: rt,
      describeError,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "healthy", buildSha: "abc", version: "1" });
    expect(res.body).not.toHaveProperty("checks");
    expect(deepChecks).not.toHaveBeenCalled();
  });

  it("deep 200 carries checks", async () => {
    const { rt } = runtime();
    const res = await serveReadyz({
      deep: true,
      local: () => ({ buildSha: "abc" }),
      deepChecks: () => [["postgres", async () => undefined]] as const,
      runtime: rt,
      describeError,
    });
    expect(res.status).toBe(200);
    expect((res.body.checks as Record<string, { status: string }>).postgres?.status).toBe("ok");
  });

  it("deep 503 carries reason/message from the first failure plus unreachable, checks and buildSha", async () => {
    const { rt } = runtime();
    const onFailure = vi.fn();
    const res = await serveReadyz({
      deep: true,
      local: () => ({ buildSha: "abc" }),
      deepChecks: () =>
        [
          ["postgres", async () => undefined],
          ["scheduler-worker", async () => Promise.reject(new Error("worker down"))],
        ] as const,
      runtime: rt,
      describeError,
      onFailure,
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "worker down",
      unreachable: ["scheduler-worker"],
      buildSha: "abc",
    });
    expect(onFailure).toHaveBeenCalledOnce();
    const reading = readDeepReadiness(res.status, res.body);
    expect(reading.dependencyState("postgres")).toBe("reached");
    expect(reading.dependencyState("scheduler-worker")).toBe("unreached");
  });

  it("a local (config) failure is 503 with no deep evidence, even on ?deep=1", async () => {
    const { rt } = runtime();
    const deepChecks = vi.fn(() => [] as const);
    const res = await serveReadyz({
      deep: true,
      local: () => {
        throw new Error("secret missing");
      },
      deepChecks,
      runtime: rt,
      describeError: () => ({ reason: "MISSING_RUNTIME_SECRET", message: "secret missing" }),
    });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "error", reason: "MISSING_RUNTIME_SECRET", message: "secret missing" });
    expect(deepChecks).not.toHaveBeenCalled();
  });
});
