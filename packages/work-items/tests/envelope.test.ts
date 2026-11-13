// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/envelope`
 * Purpose: Pins `composeItemEnvelope` (task.0118): one composition, bounded reads, unavailable never empty, one log per degraded part.
 * Scope: Pure composition over fake ports. No adapter, no database.
 * Invariants: ONE_COMPOSITION, ALL_READS_BOUNDED, UNAVAILABLE_NOT_EMPTY, DEGRADE_IS_LOGGED_ONCE, NEVER_THROWS.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { composeItemEnvelope, type EnvelopeDegradedEvent, type ItemLinksPort } from "../src/envelope.js";
import type { MoveContext, MoveReadingPort, WorkItemMove } from "../src/moves.js";

const OBS = "11111111-1111-4111-8111-111111111111";
const move: WorkItemMove = { metricId: "m", direction: "up", baselineObservationId: OBS };
const item = { id: "story.0035", moves: [move] };
const chain: MoveContext = {
  metric: { id: "m", title: "M", unit: "items" },
  kpi: { metricId: "k", title: "K", comparator: "gte", target: { value: 1, unit: "items" } },
  goal: { id: "g", title: "G" },
};
const readings = (context?: MoveReadingPort["context"]): MoveReadingPort => ({
  observation: async () => ({ value: 1, observedAt: "2026-11-01T00:00:00.000Z" }),
  latest: async () => ({ value: 2, observedAt: "2026-11-02T00:00:00.000Z" }),
  batch: async (moves) => moves.map(() => ({ baseline: { value: 1, observedAt: "x" }, current: { value: 2, observedAt: "y" } })),
  assess: () => "as_declared",
  ...(context ? { context } : {}),
});
const links = (firstPage: ItemLinksPort["firstPage"]): ItemLinksPort => ({ firstPage });
const page = { items: [], nextCursor: "n1" };

describe("composeItemEnvelope (task.0118)", () => {
  it("adds readings, the chain and (on request) links in one call", async () => {
    const out = await composeItemEnvelope(
      item,
      { readings: readings(async () => new Map([["m", chain]])), links: links(async () => page) },
      { includeLinks: true },
    );
    expect(out.moves?.[0]).toMatchObject({ ...chain, moved: "as_declared" });
    expect(out.links).toEqual(page);
  });

  it("a hung links store reads unavailable at the deadline, never a hang or an empty list, and logs once", async () => {
    const log = vi.fn<(event: EnvelopeDegradedEvent) => void>();
    const started = Date.now();
    const out = await composeItemEnvelope(
      item,
      { readings: readings(async () => new Map([["m", chain]])), links: links(() => new Promise(() => undefined)), log },
      { includeLinks: true, deadline: Date.now() + 30 },
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.links).toEqual({ items: [], nextCursor: null, unavailable: true });
    // The chain still resolved: one slow part never degrades the other.
    expect(out.moves?.[0]).toMatchObject({ kpi: { metricId: "k" } });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ part: "links", workItemId: "story.0035", reason: "BoundedReadUnavailableError" });
  });

  it("a cancelled request ends the links wait at once and the port sees the abort", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = composeItemEnvelope(
      item,
      {
        links: links((_id, signal) => {
          seen = signal;
          return new Promise(() => undefined);
        }),
      },
      { includeLinks: true, signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const started = Date.now();
    const out = await pending;
    // The abort reached the port and ended the wait immediately, long before the 3 s ceiling.
    expect(seen?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.links).toEqual({ items: [], nextCursor: null, unavailable: true });
  });

  it("a failing links store, or none wired, reads unavailable and logs one event each", async () => {
    const log = vi.fn<(event: EnvelopeDegradedEvent) => void>();
    const failing = await composeItemEnvelope(
      { id: "task.1" },
      { links: links(async () => Promise.reject(Object.assign(new Error("secret row text"), { name: "StoreDown" }))), log },
      { includeLinks: true },
    );
    expect(failing.links).toEqual({ items: [], nextCursor: null, unavailable: true });
    const none = await composeItemEnvelope({ id: "task.2" }, { log }, { includeLinks: true });
    expect(none.links?.unavailable).toBe(true);
    expect(log.mock.calls.map(([event]) => event)).toEqual([
      { part: "links", workItemId: "task.1", reason: "StoreDown" },
      { part: "links", workItemId: "task.2", reason: "no_port" },
    ]);
    // An error's message never reaches the event.
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret row text");
  });

  it("logs the chain once with how many moves did not resolve", async () => {
    const log = vi.fn<(event: EnvelopeDegradedEvent) => void>();
    const two = { id: "task.3", moves: [move, { ...move, metricId: "gone" }] };
    const partial = await composeItemEnvelope(two, { readings: readings(async () => new Map([["m", chain]])), log });
    expect(partial.moves?.[1]).toMatchObject({ context: "unavailable" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ part: "chain", workItemId: "task.3", reason: "unresolved", unresolved: 1, of: 2 });
    log.mockClear();
    await composeItemEnvelope(two, { readings: readings(async () => Promise.reject(Object.assign(new Error("x"), { name: "GoalsDown" }))), log });
    expect(log).toHaveBeenCalledWith({ part: "chain", workItemId: "task.3", reason: "GoalsDown", unresolved: 2, of: 2 });
  });

  it("chain: false skips the chain and its reads; no links unless asked; a throwing logger never fails the read", async () => {
    const context = vi.fn(async () => new Map([["m", chain]]));
    const firstPage = vi.fn(async () => page);
    const out = await composeItemEnvelope(item, { readings: readings(context), links: links(firstPage) }, { chain: false });
    expect(context).not.toHaveBeenCalled();
    expect(firstPage).not.toHaveBeenCalled();
    expect(out.moves?.[0]).not.toHaveProperty("context");
    expect(out).not.toHaveProperty("links");
    const noisy = await composeItemEnvelope(item, { log: () => { throw new Error("logger down"); } }, {});
    expect(noisy.moves?.[0]).toMatchObject({ context: "unavailable" });
  });
});
