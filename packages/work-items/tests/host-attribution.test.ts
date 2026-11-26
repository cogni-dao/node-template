// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/host-attribution`
 * Purpose: The attribution builders and the tool writers behave the same from the package entry alone (task.0175).
 * Scope: Pure functions and injected fakes. No node app, no database.
 * Invariants: ACTOR_IS_THE_PRINCIPAL; REQUESTER_IS_THE_SUBJECT; an unknown run never blocks a write.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  actingPrincipal,
  attributionFields,
  createRunAttribution,
  createWorkItemWriters,
  routeAttribution,
  runAttribution,
  WORK_ITEM_ATTRIBUTION_EVENTS,
  WORK_ITEM_WRITE_EVENTS,
} from "../src/index.js";

const P = "principal-1";
const S = "subject-1";

describe("attribution builders", () => {
  it("a run write names the principal as actor, the subject as requester and the run", () => {
    expect(
      runAttribution({ principalId: P, subjectUserId: S, runId: "r1", runKind: "system_scheduled" })
    ).toEqual({ actor: P, requestedBy: S, run: { id: "r1", kind: "system_scheduled" } });
  });

  it("a run with no principal writes nothing, even with a subject", () => {
    expect(() => actingPrincipal({ subjectUserId: S })).toThrow("no acting principal");
  });

  it("an unknown run omits the run and logs one event, and still names the principal", () => {
    const warn = vi.fn();
    const built = createRunAttribution({ scope: () => ({ principalId: P, runId: "r1" }), log: { warn } })();
    expect(built).toEqual({ actor: P });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toBe(WORK_ITEM_ATTRIBUTION_EVENTS.runMissing);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ runId: "r1", hasRunKind: false });
  });

  it("a route write has the caller as actor and nothing else", () => {
    expect(routeAttribution("caller")).toEqual({ actor: "caller" });
    expect(attributionFields({ actor: "a", requestedBy: "b", run: { id: "r", kind: "user_immediate" } })).toEqual({
      actor: "a",
      requestedBy: "b",
      runId: "r",
      runKind: "user_immediate",
    });
  });
});

describe("createWorkItemWriters", () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const build = (patch: ReturnType<typeof vi.fn>) =>
    createWorkItemWriters({
      log,
      scope: () => ({ principalId: P, subjectUserId: S, runId: "r1", runKind: "user_immediate" }),
      traceId: () => "trace-1",
      store: () => ({ patch }) as never,
      artifacts: () => undefined,
    });

  it("a tool patch is attributed from the scope and ends in the route's success event", async () => {
    const patch = vi.fn().mockResolvedValue({ id: "task.1" });
    const writers = build(patch);
    await writers.backlogWriter.store.patch({ id: "task.1" } as never, writers.backlogWriter.attribution());
    expect(patch.mock.calls[0]?.[1]).toEqual({ actor: P, requestedBy: S, run: { id: "r1", kind: "user_immediate" } });
    expect(log.info.mock.calls.at(-1)?.[0]).toMatchObject({
      event: WORK_ITEM_WRITE_EVENTS.patchSuccess,
      via: "tool",
      traceId: "trace-1",
      actor: P,
      requestedBy: S,
    });
  });

  it("a denied attribution is one refused event", () => {
    build(vi.fn()).backlogWriter.attributionDenied({ workItemId: "task.1", error: new Error("x") });
    expect(log.info.mock.calls.at(-1)?.[0]).toMatchObject({
      event: WORK_ITEM_WRITE_EVENTS.patchRefused,
      status: 403,
      errorCode: "attribution_denied",
    });
  });
});
