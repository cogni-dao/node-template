// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/orgs.route`
 * Purpose: POST /api/v1/orgs writes nothing for a caller who is not one of the source's owners (story.0038): the owner source is read BEFORE `ensureOrg`, a non-owner is
 *   403, an unreadable owner source is 503, a bad ref or path is 400, and only an owner reaches `ensureOrg`.
 * Scope: The real route handler with a fake container; no database, no network.
 * Side-effects: none
 */

import { OwnerSourceUnavailableError } from "@cogni/agent-grants/orgs";
import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ owners: vi.fn(), ensureOrg: vi.fn() }));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request, user: unknown) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }, request, { id: "caller-1", via: "session" }),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    serviceAuth: { owners: { owners: fake.owners } },
    agentAuthority: { ensureOrg: fake.ensureOrg },
  }),
}));

import { POST } from "@/app/api/v1/orgs/route";

const REF = "https://github.com/cogni-dao/poly";
const call = (source: unknown) =>
  POST(
    new NextRequest("http://localhost/api/v1/orgs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    }),
    undefined as never
  );

describe("POST /api/v1/orgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.owners.mockResolvedValue(["caller-1", "someone-else"]);
    fake.ensureOrg.mockResolvedValue({ userId: "org-1", billingAccountId: "ba-1" });
  });

  it("an owner of the source gets the org, and the owner read happens first", async () => {
    const res = await call({ kind: "repo-spec", ref: REF });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgUserId: "org-1", billingAccountId: "ba-1" });
    expect(fake.owners).toHaveBeenCalledWith({ kind: "repo-spec", ref: REF });
    expect(fake.owners.mock.invocationCallOrder[0]).toBeLessThan(fake.ensureOrg.mock.invocationCallOrder[0] as number);
  });

  it("a caller who is not an owner is 403 and nothing is written", async () => {
    fake.owners.mockResolvedValue(["someone-else"]);
    const res = await call({ kind: "repo-spec", ref: REF });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_an_owner" });
    expect(fake.ensureOrg).not.toHaveBeenCalled();
  });

  it("an unreadable owner source is 503 and nothing is written", async () => {
    fake.owners.mockRejectedValue(new OwnerSourceUnavailableError("no_approvers"));
    const res = await call({ kind: "repo-spec", ref: REF });
    expect(res.status).toBe(503);
    expect(fake.ensureOrg).not.toHaveBeenCalled();
  });

  it("a ref or path that is not canonical is 400 before any owner read", async () => {
    for (const source of [
      { kind: "repo-spec", ref: "https://evil.example/a/b" },
      { kind: "repo-spec", ref: REF, path: "../.cogni/repo-spec.yaml" },
      { kind: "repo-spec", ref: REF, path: "/abs/.cogni/repo-spec.yaml" },
    ])
      expect((await call(source)).status).toBe(400);
    expect(fake.owners).not.toHaveBeenCalled();
    expect(fake.ensureOrg).not.toHaveBeenCalled();
  });
});
