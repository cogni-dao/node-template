// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** HTTP parsing, facade delegation, and conflict mapping must preserve revision CAS. */
import {
  CHANGE_REASON_REQUIRED_MESSAGE,
  EntryResolverUnavailableError,
  EntryUnresolvedError,
} from "@cogni/work-items";
import { WorkItemRevisionConflictError } from "@cogni/work-items/adapters/doltgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { PATCH } from "@/app/api/v1/work/items/[id]/route";
import { getContainer } from "@/bootstrap/container";

type Handler = (
  context: unknown,
  request: Request,
  user: unknown,
  route: unknown
) => Promise<Response>;

const patch = vi.fn();
const item = {
  id: "task.0001",
  type: "task",
  title: "Revision fixture",
  status: "needs_implement",
  priority: 2,
  rank: 0,
  estimate: 1,
  summary: "updated",
  outcome: "",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 8,
  deployVerified: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
};

function request(body: unknown): Promise<Response> {
  return (PATCH as unknown as Handler)(
    { log: { info: vi.fn() } },
    new Request("http://localhost/api/v1/work/items/task.0001", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { id: "principal-1" },
    { params: Promise.resolve({ id: "task.0001" }) }
  );
}

describe("work-item revision HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getContainer).mockReturnValue({
      doltgresWorkItems: { patch },
    } as never);
    patch.mockResolvedValue(item);
  });

  it("forwards the caller's revision through the real facade and returns the new revision", async () => {
    const response = await request({
      expectedRevision: 7,
      reason: "r",
      set: { summary: "updated" },
    });
    expect(response.status).toBe(200);
    expect(patch).toHaveBeenCalledWith(
      {
        id: "task.0001",
        expectedRevision: 7,
        reason: "r",
        set: { summary: "updated" },
      },
      "principal-1"
    );
    expect(await response.json()).toMatchObject({ revision: 8 });
  });

  it("maps a stale revision to a distinct 409 with the actual current revision", async () => {
    patch.mockRejectedValue(
      new WorkItemRevisionConflictError("task.0001", 7, 8)
    );
    const response = await request({
      expectedRevision: 7,
      reason: "r",
      set: { summary: "updated" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "revision_conflict",
      expectedRevision: 7,
      currentRevision: 8,
    });
  });

  it.each([
    -1,
    0.5,
    "7",
    null,
  ])("rejects invalid expectedRevision %j before the store", async (expectedRevision) => {
    const response = await request({
      expectedRevision,
      reason: "r",
      set: { summary: "updated" },
    });
    expect(response.status).toBe(400);
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps legacy patches unconditional when expectedRevision is omitted", async () => {
    const response = await request({ reason: "r", set: { summary: "updated" } });
    expect(response.status).toBe(200);
    expect(patch).toHaveBeenCalledWith(
      { id: "task.0001", reason: "r", set: { summary: "updated" } },
      "principal-1"
    );
  });

  it("rejects a patch without a reason with a 400 that names the field, before the store (task.0086)", async () => {
    const response = await request({ expectedRevision: 7, set: { summary: "updated" } });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid input");
    expect(body.issues).toEqual([
      expect.objectContaining({ path: ["reason"], message: CHANGE_REASON_REQUIRED_MESSAGE }),
    ]);
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([
    ["26 words", Array.from({ length: 26 }, () => "w").join(" ")],
    ["241 characters", "x".repeat(241)],
    ["a NUL", "a\u0000b"],
  ])("rejects a reason of %s with a 400 before the store", async (_name, reason) => {
    const response = await request({ reason, set: { summary: "updated" } });
    expect(response.status).toBe(400);
    expect(patch).not.toHaveBeenCalled();
  });

  it("forwards cites and logs citeCount, not a flag (task.0086)", async () => {
    const info = vi.fn();
    const cites = [{ id: "change-history-design" }, { id: "x-1", contribution: "contrib-x" }];
    const response = await (PATCH as unknown as Handler)(
      { log: { info } },
      new Request("http://localhost/api/v1/work/items/task.0001", {
        method: "PATCH",
        body: JSON.stringify({ reason: "r", cites, set: { summary: "updated" } }),
      }),
      { id: "principal-1" },
      { params: Promise.resolve({ id: "task.0001" }) }
    );
    expect(response.status).toBe(200);
    expect(patch).toHaveBeenCalledWith(
      { id: "task.0001", reason: "r", cites, set: { summary: "updated" } },
      "principal-1"
    );
    expect(info).toHaveBeenCalledWith({ workItemId: "task.0001", citeCount: 2 }, "work.items.patch_success");
  });

  it("maps an unresolved cite to 400 cite_unresolved with the ids, and a resolver failure to 503", async () => {
    patch.mockRejectedValue(new EntryUnresolvedError(["ghost"]));
    const unresolved = await request({ reason: "r", cites: [{ id: "ghost" }], set: { summary: "x" } });
    expect(unresolved.status).toBe(400);
    expect(await unresolved.json()).toMatchObject({
      error: "invalid input",
      errorCode: "cite_unresolved",
      ids: ["ghost"],
    });
    patch.mockRejectedValue(new EntryResolverUnavailableError());
    const unavailable = await request({ reason: "r", cites: [{ id: "a-b" }], set: { summary: "x" } });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ errorCode: "cite_resolver_unavailable" });
  });

  it("maps adapter-bundle copies of the resolver errors by name, and cites_unsupported to 400", async () => {
    patch.mockRejectedValue(
      Object.assign(new Error("copy"), { name: "EntryUnresolvedError", ids: ["ghost"] })
    );
    const unresolved = await request({ reason: "r", cites: [{ id: "ghost" }], set: { summary: "x" } });
    expect(unresolved.status).toBe(400);
    expect(await unresolved.json()).toMatchObject({ errorCode: "cite_unresolved", ids: ["ghost"] });

    patch.mockRejectedValue(Object.assign(new Error("copy"), { name: "EntryResolverUnavailableError" }));
    expect((await request({ reason: "r", cites: [{ id: "a-b" }], set: { summary: "x" } })).status).toBe(503);

    patch.mockRejectedValue(Object.assign(new Error("none"), { name: "CitesUnsupportedError" }));
    const unsupported = await request({ reason: "r", cites: [{ id: "a-b" }], set: { summary: "x" } });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ errorCode: "cites_unsupported" });
  });

  it("maps a reason the adapter rejects to 400 at the reason path (defense in depth)", async () => {
    patch.mockRejectedValue(
      Object.assign(new Error("reason must be at most 25 words"), { name: "ChangeReasonInvalidError" })
    );
    const response = await request({ reason: "r", set: { summary: "x" } });
    expect(response.status).toBe(400);
    expect((await response.json()).issues[0]).toMatchObject({ path: ["reason"] });
  });

  it("keeps writer admission failures as 503", async () => {
    patch.mockRejectedValue(
      Object.assign(new Error("writer busy"), { name: "WorkItemsBusyError" })
    );
    const response = await request({
      expectedRevision: 7,
      reason: "r",
      set: { summary: "updated" },
    });
    expect(response.status).toBe(503);
  });
});
