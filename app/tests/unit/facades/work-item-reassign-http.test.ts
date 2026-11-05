// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-item-reassign-http`
 * Purpose: POST /api/v1/work/items/reassign is session-only node admin, validates principals, and a dry run never writes (bug.0013).
 * Scope: Real route + facade with a mocked container, users lookup and work-item store. No Doltgres.
 * Invariants: SESSION_ONLY, REASSIGN_IS_NODE_ADMIN (FAIL_CLOSED_WITH_DISTINCTION), DRY_RUN_WRITES_NOTHING.
 * Side-effects: none
 * Links: src/app/api/v1/work/items/reassign/route.ts, https://node-template.cognidao.org/work/items/bug.0013
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(),
  resolveServiceDb: vi.fn(),
}));

import { POST } from "@/app/api/v1/work/items/reassign/route";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";

type Handler = (
  context: unknown,
  request: Request,
  user: unknown
) => Promise<Response>;

const FROM = "d21ba072-e928-4653-bf22-ba83972453cf";
const TO = "52d379aa-e925-4da9-8e6b-2fd62e8a10d0";
const admin = { id: "admin-1", walletAddress: "0xabc" };

const reassignCreator = vi.fn();
const check = vi.fn();
const info = vi.fn();
const targetRows = vi.fn();

function post(
  body: unknown,
  options: { bearer?: boolean; user?: unknown } = {}
): Promise<Response> {
  return (POST as unknown as Handler)(
    { log: { info } },
    new Request("http://localhost/api/v1/work/items/reassign", {
      method: "POST",
      headers: options.bearer ? { authorization: "Bearer cogni_ag_sk_x" } : {},
      body: JSON.stringify(body),
    }),
    options.user ?? admin
  );
}

describe("POST /api/v1/work/items/reassign (bug.0013)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getContainer).mockReturnValue({
      nodeAdmin: { check },
      doltgresWorkItems: { reassignCreator },
      log: { warn: vi.fn() },
    } as never);
    vi.mocked(resolveServiceDb).mockReturnValue({
      select: () => ({
        from: () => ({ where: () => ({ limit: targetRows }) }),
      }),
    } as never);
    check.mockResolvedValue({ ok: true });
    targetRows.mockResolvedValue([{ id: TO }]);
    reassignCreator.mockResolvedValue({ ids: ["bug.0011", "task.0036"] });
  });

  it("rejects an agent bearer key before any authorization or store call", async () => {
    const res = await post(
      { fromPrincipalId: FROM, toPrincipalId: TO },
      { bearer: true, user: { id: FROM, walletAddress: null } }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errorCode: "session_required" });
    expect(check).not.toHaveBeenCalled();
    expect(reassignCreator).not.toHaveBeenCalled();
  });

  it("refuses a non-admin session with 403 authz_denied and writes nothing", async () => {
    check.mockResolvedValue({ ok: false, errorCode: "authz_denied" });
    const res = await post({ fromPrincipalId: FROM, toPrincipalId: TO });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errorCode: "authz_denied" });
    expect(check).toHaveBeenCalledWith({
      userId: "admin-1",
      walletAddress: "0xabc",
    });
    expect(targetRows).not.toHaveBeenCalled();
    expect(reassignCreator).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when no admin authority is configured", async () => {
    check.mockResolvedValue({
      ok: false,
      errorCode: "authz_unavailable",
      reason: "no_node_admins_configured",
    });
    const res = await post({ fromPrincipalId: FROM, toPrincipalId: TO });
    expect(res.status).toBe(503);
    expect(reassignCreator).not.toHaveBeenCalled();
  });

  it.each([
    { fromPrincipalId: "not-a-uuid", toPrincipalId: TO },
    { fromPrincipalId: FROM, toPrincipalId: FROM },
    { fromPrincipalId: FROM },
  ])("rejects invalid input %j with 400", async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(reassignCreator).not.toHaveBeenCalled();
  });

  it("requires the target principal to be an existing user", async () => {
    targetRows.mockResolvedValue([]);
    const res = await post({ fromPrincipalId: FROM, toPrincipalId: TO });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      errorCode: "target_principal_not_found",
    });
    expect(reassignCreator).not.toHaveBeenCalled();
  });

  it("dryRun previews ids through the store's read path and logs no write", async () => {
    const res = await post({
      fromPrincipalId: FROM,
      toPrincipalId: TO,
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fromPrincipalId: FROM,
      toPrincipalId: TO,
      dryRun: true,
      count: 2,
      ids: ["bug.0011", "task.0036"],
    });
    expect(reassignCreator).toHaveBeenCalledWith({
      fromPrincipalId: FROM,
      toPrincipalId: TO,
      actorPrincipalId: "admin-1",
      dryRun: true,
    });
    expect(info).not.toHaveBeenCalledWith(
      expect.anything(),
      "work.items.reassigned"
    );
  });

  it("reassigns for a node admin and logs one work.items.reassigned event", async () => {
    const res = await post({ fromPrincipalId: FROM, toPrincipalId: TO });
    expect(res.status).toBe(200);
    expect(reassignCreator).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, actorPrincipalId: "admin-1" })
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { from: FROM, to: TO, count: 2, actor: "admin-1", dryRun: false },
      "work.items.reassigned"
    );
  });
});
