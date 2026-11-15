// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-item-create-refusal-events`
 * Purpose: Every refused `POST /api/v1/work/items` ends in ONE registered terminal event with its errorCode (task.0122): a status other than
 *   needs_triage, an invalid body, a store refusal. A success still logs its own event and no refusal.
 * Scope: The real route and facade over a stubbed container; the logger is a spy. No database.
 * Invariants: ONE_TERMINAL_EVENT_PER_REFUSAL, ERROR_CODE_NEVER_BODY.
 * Side-effects: none
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { POST } from "@/app/api/v1/work/items/route";
import { getContainer } from "@/bootstrap/container";

type Handler = (context: unknown, request: Request, user: unknown) => Promise<Response>;

const create = vi.fn();
const info = vi.fn();
const post = (body: unknown) =>
  (POST as unknown as Handler)(
    { log: { info }, reqId: "req-1", routeId: "work.items.create" },
    new Request("http://localhost/api/v1/work/items", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { id: "principal-1" }
  );
const refusals = () =>
  info.mock.calls
    .map(([fields]) => fields as Record<string, unknown>)
    .filter((fields) => fields.event === "work.items.create_refused");

beforeEach(() => {
  vi.clearAllMocks();
  create.mockReset();
  vi.mocked(getContainer).mockReturnValue({
    workItemCommand: { create },
    doltgresWorkItems: { create },
  } as never);
});

describe("POST /api/v1/work/items refusals", () => {
  it("a create in a status other than needs_triage is one create_refused event with errorCode invalid_input, and nothing is written", async () => {
    const res = await post({ type: "task", title: "skip triage", status: "needs_implement" });
    expect(res.status).toBe(400);
    expect(refusals()).toEqual([
      { event: "work.items.create_refused", routeId: "work.items.create", outcome: "refused", status: 400, errorCode: "invalid_input" },
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it("an unparseable body is one event with errorCode invalid_json", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect(refusals()).toEqual([expect.objectContaining({ status: 400, errorCode: "invalid_json" })]);
  });

  it("a store refusal keeps its own errorCode (the store's gate on a create in another status)", async () => {
    create.mockRejectedValue(
      Object.assign(new Error("gate"), {
        name: "WorkItemGateUnmetError",
        from: "create",
        to: "needs_implement",
        missing: "path",
      })
    );
    const res = await post({ type: "task", title: "a title" });
    expect(res.status).toBe(409);
    expect(refusals()).toEqual([expect.objectContaining({ status: 409, errorCode: "gate_unmet" })]);
  });

  it("never carries the request body in the event", async () => {
    await post({ type: "task", title: "SECRET TITLE", summary: "SECRET SUMMARY", status: "done" });
    expect(JSON.stringify(info.mock.calls)).not.toContain("SECRET");
  });
});
