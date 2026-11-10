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
  runDeepChecks,
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
