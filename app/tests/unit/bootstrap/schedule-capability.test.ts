// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/schedule-capability`
 * Purpose: Prove the AI schedule capability keeps one job per owner and purpose.
 * Scope: Unit — injected ScheduleUserPort fake; no database or Temporal.
 * Invariants: PURPOSE_REUSE, PURPOSE_CREATE_SERIALIZED, PURPOSE_MISMATCH_REFUSED.
 * Side-effects: none
 * @internal
 */

import type { ScheduleSpec, ScheduleUserPort } from "@cogni/scheduler-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/config", () => ({ getNodeId: () => "node-1" }));

import { runInScope } from "@/adapters/server/ai/execution-scope";
import { createScheduleCapability } from "@/bootstrap/capabilities/schedule";

const USER = "00000000-0000-4000-a000-000000000001";
const MODEL = { providerKey: "platform", modelId: "free-model" };

function fakeManager() {
  const rows: ScheduleSpec[] = [];
  const createSchedule = vi.fn(
    async (ownerUserId: string, _billing: string, input: { graphId: string; input: unknown; cron: string; timezone: string }) => {
      // Yield so concurrent callers interleave exactly where a race would occur.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const now = new Date(Date.now() + rows.length);
      const row: ScheduleSpec = {
        id: `s${rows.length + 1}`,
        ownerUserId,
        executionGrantId: "grant",
        graphId: input.graphId,
        input: input.input,
        cron: input.cron,
        timezone: input.timezone,
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return row;
    },
  );
  const manager = {
    listSchedules: vi.fn(async () => [...rows]),
    createSchedule,
  } as unknown as ScheduleUserPort;
  return { manager, rows, createSchedule };
}

function capability(manager: ScheduleUserPort) {
  return createScheduleCapability({
    scheduleManager: manager,
    getOrCreateBillingAccountId: async () => "billing",
  });
}

const job = (cron = "0 * * * *") => ({
  graphId: "langgraph:work-prioritizer",
  cron,
  timezone: "UTC",
  input: {
    messages: [{ role: "user", content: "Triage open work." }],
    _meta: { purpose: "node-work-triage" },
  },
});

const inScope = <T>(fn: () => Promise<T>) =>
  runInScope(
    {
      billing: { billingAccountId: "billing", virtualKeyId: "vk" },
      subjectUserId: USER,
      modelRef: MODEL,
    } as never,
    fn,
  );

describe("ScheduleCapability.create", () => {
  it("reuses an existing job with the same purpose and configuration", async () => {
    const { manager, createSchedule } = fakeManager();
    const cap = capability(manager);
    const first = await inScope(() => cap.create(job()));
    const second = await inScope(() => cap.create(job()));
    expect(second.id).toBe(first.id);
    expect(createSchedule).toHaveBeenCalledTimes(1);
  });

  it("creates one job when callers race on the same purpose", async () => {
    const { manager, createSchedule } = fakeManager();
    const cap = capability(manager);
    const results = await Promise.all([
      inScope(() => cap.create(job())),
      inScope(() => cap.create(job())),
      inScope(() => cap.create(job())),
    ]);
    expect(createSchedule).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  it("refuses a different configuration for an existing purpose", async () => {
    const { manager, createSchedule } = fakeManager();
    const cap = capability(manager);
    await inScope(() => cap.create(job()));
    await expect(inScope(() => cap.create(job("*/5 * * * *")))).rejects.toThrow(
      "different configuration",
    );
    expect(createSchedule).toHaveBeenCalledTimes(1);
  });

  it("reuses the oldest matching job when duplicates already exist", async () => {
    const { manager, rows } = fakeManager();
    const cap = capability(manager);
    const first = await inScope(() => cap.create(job()));
    rows.push({ ...rows[0]!, id: "dup", createdAt: new Date(Date.now() + 1000) });
    const again = await inScope(() => cap.create(job()));
    expect(again.id).toBe(first.id);
  });

  it("rejects an unregistered workflow", async () => {
    const { manager } = fakeManager();
    await expect(
      inScope(() => capability(manager).create({ ...job(), graphId: "langgraph:nope" })),
    ).rejects.toThrow("not registered");
  });
});
