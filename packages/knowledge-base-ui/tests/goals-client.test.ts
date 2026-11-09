// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals-client.test`
 * Purpose: Prove the Goals read contract: each read hits the documented path, parses with the shared wire schema, and fails with the HTTP status; the entry imports no router.
 * Scope: createGoalsClient over an injected fetch.
 * Invariants: ONE_WIRE_CONTRACT; STATUS_ON_ERROR; BUCKETS_LE_400; NO_ROUTER_IMPORT.
 * Side-effects: reads this package's source files
 * Links: task.0062, ../src/goals/client.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createGoalsClient,
  GoalsReadError,
  goalsErrorStatus,
  historyWindow,
} from "../src/goals.js";
import { history, visualFixture } from "./_fixtures/goals-progress.js";

describe("createGoalsClient", () => {
  it("reads goals, history, metric and observation from the metrics routes", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/goals")) return Response.json(visualFixture());
      if (url.includes("/history?"))
        return Response.json(
          history("m 1", "ratio", "1h", "2026-11-02T10:00:00.000Z", [0.5, 0.6])
        );
      return new Response("{}", { status: 404 });
    });
    const c = createGoalsClient({ fetch: fetchMock as unknown as typeof fetch });
    expect((await c.fetchGoals()).goals).toHaveLength(3);
    const window = historyWindow("1w", Date.parse("2026-11-02T10:05:00Z"));
    expect((await c.fetchHistory("m 1", window)).buckets).toHaveLength(2);
    expect(urls[0]).toBe("/api/v1/metrics/goals");
    const qs = new URLSearchParams({
      from: window.from,
      to: window.to,
      step: "1h",
    }).toString();
    expect(urls[1]).toBe(`/api/v1/metrics/m%201/history?${qs}`);
    // 168 hourly buckets for a week: always an aligned, bounded window.
    expect((Date.parse(window.to) - Date.parse(window.from)) / 3_600_000).toBe(168);
    await expect(c.fetchMetric("m")).rejects.toMatchObject({
      resource: "metric",
      status: 404,
    });
    await expect(c.fetchObservation("m", "o 1")).rejects.toMatchObject({
      resource: "observation",
      status: 404,
    });
    expect(urls[3]).toBe("/api/v1/metrics/m/observations/o%201");
  });

  it("rejects a body that is not the wire contract", async () => {
    const c = createGoalsClient({
      fetch: (async () => Response.json({ goals: "nope" })) as unknown as typeof fetch,
    });
    await expect(c.fetchGoals()).rejects.toThrow();
  });

  it("carries the status of any failed read", async () => {
    const c = createGoalsClient({
      fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
    });
    const error = await c.fetchGoals().catch((e) => e);
    expect(error).toBeInstanceOf(GoalsReadError);
    expect(goalsErrorStatus(error)).toBe(401);
    expect(goalsErrorStatus(Object.assign(new Error("x"), { status: 503 }))).toBe(503);
    expect(goalsErrorStatus(new Error("x"))).toBeNull();
    expect(goalsErrorStatus("x")).toBeNull();
  });
});

describe("goals entry boundary", () => {
  it("imports no router, node app code or private node kit", () => {
    const dir = join(__dirname, "..", "src", "goals");
    const files = [...readdirSync(dir).map((f) => join(dir, f)), join(dir, "..", "goals.ts")];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from "next\//);
      expect(source, file).not.toMatch(/from "@\//);
      expect(source, file).not.toMatch(/@cogni\/node-ui-kit/);
    }
  });
});
