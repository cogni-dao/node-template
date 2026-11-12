// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/metrics-goals-route`
 * Purpose: Prove `GET /api/v1/metrics/goals` tells a stale 200 from a fresh one in its `goals.progress_read` log event (bug.0035).
 * Scope: The real route handler with the metrics facade stubbed; no database.
 * Invariants:
 *   - STALE_VISIBLE: a body carrying `stale` logs `stale: true` with its reason and age; a fresh body logs `stale: false` and no reason.
 * Side-effects: none
 * Links: src/app/api/v1/metrics/goals/route.ts, packages/metrics/src/contracts.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
const goals = vi.fn();
vi.mock("@/app/_facades/metrics.server", () => ({
  metricHandlers: () => ({ goals }),
  metricResponse: (result: { status: number; body: unknown }) =>
    Response.json(result.body, { status: result.status }),
  metricHttpError: () => Response.json({ error: "x" }, { status: 503 }),
}));
const logEvent = vi.fn();
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: { GOALS_PROGRESS_READ: "goals.progress_read" },
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

import { GET } from "@/app/api/v1/metrics/goals/route";

type Handler = (
  context: unknown,
  request: Request,
  user: unknown
) => Promise<Response>;
const ctx = { log: {}, reqId: "req-1", routeId: "metrics.goalsRead" };
const body = { asOf: "2026-11-12T20:00:00.000Z", environment: "test", goals: [] };

function read() {
  return (GET as unknown as Handler)(
    ctx,
    new Request("http://localhost/api/v1/metrics/goals"),
    { id: "user-1" }
  );
}
const fields = () => logEvent.mock.calls[0]?.[2] as Record<string, unknown>;

describe("GET /api/v1/metrics/goals logging (bug.0035)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs a served last-good body as stale, with its reason and age", async () => {
    goals.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ...body,
        stale: { reason: "fresh_read_slow", ageSeconds: 42 },
      },
    });
    expect((await read()).status).toBe(200);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(fields()).toMatchObject({
      outcome: "success",
      status: 200,
      stale: true,
      staleReason: "fresh_read_slow",
      staleAgeSeconds: 42,
    });
  });

  it("logs a fresh body as not stale, with no reason or age", async () => {
    goals.mockResolvedValue({ ok: true, status: 200, body });
    await read();
    expect(fields()).toMatchObject({ outcome: "success", stale: false });
    expect(fields()).not.toHaveProperty("staleReason");
    expect(fields()).not.toHaveProperty("staleAgeSeconds");
  });
});
