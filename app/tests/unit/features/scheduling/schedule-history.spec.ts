// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: tests/unit/features/scheduling/schedule-history
 * Purpose: Verify owned schedule readback and exact saved response selection.
 * Scope: Public service seams with injected ports; database isolation has component coverage.
 * Invariants: No cross-owner reads, no latest-message substitution, no text truncation.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5353
 * @internal
 */
import { toUserId } from "@cogni/ids";
import type { GraphRun, ScheduleSpec } from "@cogni/scheduler-core";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduleHistoryService } from "@/features/scheduling/services/schedule-history";
import { EVENT_NAMES } from "@/shared/observability";

const caller = toUserId("11111111-1111-4111-8111-111111111111");
const schedule: ScheduleSpec = {
  id: "22222222-2222-4222-8222-222222222222",
  ownerUserId: caller,
  executionGrantId: "33333333-3333-4333-8333-333333333333",
  graphId: "test:history",
  input: {},
  cron: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: new Date("2026-10-24T00:00:00Z"),
  updatedAt: new Date("2026-10-24T00:00:00Z"),
};
const run = {
  id: "row-a",
  runId: "run-a",
  scheduleId: schedule.id,
  stateKey: "slot-a",
  requestedBy: null,
  status: "success",
  scheduledFor: new Date("2026-10-24T01:00:00Z"),
  startedAt: null,
  completedAt: null,
  errorCode: null,
} as GraphRun;
const getSchedule = vi.fn();
const listRuns = vi.fn();
const getRun = vi.fn();
const loadThread = vi.fn();
const threadPersistenceForUser = vi.fn(() => ({ loadThread }));
const service = createScheduleHistoryService({
  schedules: { getSchedule },
  reader: { listRuns, getRun },
  threadPersistenceForUser,
});

describe("owned schedule history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSchedule.mockResolvedValue(schedule);
    getRun.mockResolvedValue(run);
    listRuns.mockResolvedValue([run]);
    loadThread.mockResolvedValue([]);
  });

  it("denies a foreign schedule before querying runs or threads", async () => {
    getSchedule.mockResolvedValue({ ...schedule, ownerUserId: "other" });
    await expect(
      service.output(caller, schedule.id, run.runId)
    ).rejects.toThrow("Schedule not found");
    expect(getRun).not.toHaveBeenCalled();
    expect(loadThread).not.toHaveBeenCalled();
  });

  it("denies same-owner run addressed through the wrong schedule", async () => {
    getRun.mockResolvedValue({ ...run, scheduleId: "another" });
    await expect(
      service.output(caller, schedule.id, run.runId)
    ).rejects.toThrow("Run not found");
    expect(loadThread).not.toHaveBeenCalled();
  });

  it("preserves schedule-owner history when requester is null", async () => {
    const result = await service.history(caller, schedule.id, { limit: 20 });
    expect(result.runs[0]?.runId).toBe(run.runId);
    expect(result.runs[0]).not.toHaveProperty("stateKey");
    expect(result.runs[0]).not.toHaveProperty("requestedBy");
    expect(loadThread).not.toHaveBeenCalled();
  });

  it("returns all exact saved assistant text, not a later assistant or tools", async () => {
    const text = "A useful complete result. ".repeat(3000);
    loadThread.mockResolvedValue([
      {
        id: "assistant-run-a",
        role: "user",
        parts: [{ type: "text", text: "wrong role" }],
      },
      {
        id: "assistant-run-a",
        role: "assistant",
        parts: [
          { type: "text", text },
          { type: "dynamic-tool", output: "private tool payload" },
          { type: "text", text: "Conclusion." },
        ],
      },
      {
        id: "assistant-later-run",
        role: "assistant",
        parts: [{ type: "text", text: "wrong run" }],
      },
    ]);
    expect(await service.output(caller, schedule.id, run.runId)).toEqual({
      availability: "available",
      text: `${text}\n\nConclusion.`,
    });
    expect(threadPersistenceForUser).toHaveBeenCalledWith(caller);
    expect(loadThread).toHaveBeenCalledWith(caller, "slot-a");
  });

  it("distinguishes absent output from a saved empty assistant", async () => {
    expect(await service.output(caller, schedule.id, run.runId)).toEqual({
      availability: "unavailable",
      text: null,
    });
    loadThread.mockResolvedValue([
      { id: "assistant-run-a", role: "assistant", parts: [] },
    ]);
    expect(await service.output(caller, schedule.id, run.runId)).toEqual({
      availability: "empty",
      text: "",
    });
  });

  it("does not read a thread without saved correlation", async () => {
    getRun.mockResolvedValue({ ...run, stateKey: null });
    expect(
      (await service.output(caller, schedule.id, run.runId)).availability
    ).toBe("unavailable");
    expect(loadThread).not.toHaveBeenCalled();
  });

  it("paginates metadata with an extra row and leaves output unloaded", async () => {
    listRuns.mockResolvedValue([run, { ...run, id: "row-b" }]);
    const result = await service.history(caller, schedule.id, { limit: 1 });
    expect(result.runs).toHaveLength(1);
    expect(result.nextCursor).toBe("row-a");
    expect(loadThread).not.toHaveBeenCalled();
  });
});

const session = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: session }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: logger,
    config: { unhandledErrorPolicy: "respond_500" },
    scheduleManager: { getSchedule },
    scheduleRunReader: { listRuns, getRun },
    threadPersistenceForUser,
  }),
}));

describe("schedule history HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.mockResolvedValue({
      id: caller,
      walletAddress: "0x0000000000000000000000000000000000000001",
    });
    getSchedule.mockResolvedValue(schedule);
    listRuns.mockResolvedValue([]);
    getRun.mockResolvedValue(run);
    loadThread.mockResolvedValue([]);
  });
  it("requires authentication", async () => {
    session.mockResolvedValue(null);
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/route"
    );
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id },
      test: async ({ fetch }) => {
        expect((await fetch()).status).toBe(401);
        expect(getSchedule).not.toHaveBeenCalled();
      },
    });
  });
  it("rejects malformed pagination before reading storage", async () => {
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/route"
    );
    await testApiHandler({
      appHandler,
      url: "http://localhost/api/v1/schedules/x/runs?limit=99",
      params: { scheduleId: schedule.id },
      test: async ({ fetch }) => {
        expect((await fetch()).status).toBe(400);
        expect(getSchedule).not.toHaveBeenCalled();
      },
    });
  });
  it("returns no-store metadata without fanout to output", async () => {
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/route"
    );
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id },
      test: async ({ fetch }) => {
        const response = await fetch();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ runs: [], nextCursor: null });
        expect(loadThread).not.toHaveBeenCalled();
      },
    });
  });
  it.each([
    "history",
    "detail",
  ] as const)("rejects invalid %s output without a false success event", async (kind) => {
    listRuns.mockResolvedValue([run]); // Invalid persisted row UUID.
    getSchedule.mockResolvedValue({ ...schedule, graphId: null });
    const appHandler =
      kind === "history"
        ? await import("@/app/api/v1/schedules/[scheduleId]/runs/route")
        : await import("@/app/api/v1/schedules/[scheduleId]/route");
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id },
      test: async ({ fetch }) => {
        const response = await fetch();
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: "Internal server error",
        });
        expect(logger.info).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "success" }),
          expect.anything()
        );
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: "INTERNAL_SERVER_ERROR" }),
          "request failed"
        );
        expect(
          logger.info.mock.calls.length +
            logger.warn.mock.calls.length +
            logger.error.mock.calls.length
        ).toBe(3);
      },
    });
  });
  it.each([
    "history",
    "output",
  ] as const)("reports %s storage failure as an error instead of an empty result", async (kind) => {
    listRuns.mockRejectedValue(new Error("Storage unavailable"));
    loadThread.mockRejectedValue(new Error("Storage unavailable"));
    const appHandler =
      kind === "history"
        ? await import("@/app/api/v1/schedules/[scheduleId]/runs/route")
        : await import(
            "@/app/api/v1/schedules/[scheduleId]/runs/[runId]/route"
          );
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id, runId: run.runId },
      test: async ({ fetch }) => {
        const response = await fetch();
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: "Internal server error",
        });
        expect(logger.info).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "success" }),
          expect.anything()
        );
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: "INTERNAL_SERVER_ERROR" }),
          "request failed"
        );
        expect(
          logger.info.mock.calls.length +
            logger.warn.mock.calls.length +
            logger.error.mock.calls.length
        ).toBe(3);
      },
    });
  });
  it("logs a validated saved output response once", async () => {
    loadThread.mockResolvedValue([
      {
        id: "assistant-run-a",
        role: "assistant",
        parts: [{ type: "text", text: "Saved result" }],
      },
    ]);
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/[runId]/route"
    );
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id, runId: run.runId },
      test: async ({ fetch }) => {
        const response = await fetch();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          availability: "available",
          text: "Saved result",
        });
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            event: EVENT_NAMES.SCHEDULE_OUTPUT_READ,
            availability: "available",
            outcome: "success",
            status: 200,
          }),
          EVENT_NAMES.SCHEDULE_OUTPUT_READ
        );
        expect(logger.info).toHaveBeenCalledTimes(3);
        expect(logger.error).not.toHaveBeenCalled();
      },
    });
  });
  it("returns the same 404 for unknown and foreign output", async () => {
    getSchedule.mockResolvedValue(null);
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/[runId]/route"
    );
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id, runId: run.runId },
      test: async ({ fetch }) => {
        expect((await fetch()).status).toBe(404);
        expect(loadThread).not.toHaveBeenCalled();
      },
    });
  });
});
