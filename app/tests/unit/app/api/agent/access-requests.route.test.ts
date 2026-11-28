// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Tests the authenticated access-request route's session Origin boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ via: "session", origin: "https://node.example", ask: vi.fn(), list: vi.fn() }));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: (ctx: { log: object }, request: Request, user: { id: string; via: string }) => unknown) =>
    (request: Request) => handler({ log: {} }, request, { id: "caller", via: state.via }),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/shared/env/server-env", () => ({ serverEnv: () => ({ APP_BASE_URL: state.origin }) }));
vi.mock("@/bootstrap/container", () => ({ getContainer: () => ({ agentAuthority: {} }) }));
vi.mock("@/app/_lib/agent-access/respond", () => ({
  httpDeps: () => ({}), readJsonBody: (request: Request) => request.json(),
  send: (response: { body: unknown; status: number; headers: Record<string, string> }) => Response.json(response.body, response),
}));
vi.mock("@cogni/agent-grants/http", () => ({ accessRequestCreateHttp: state.ask, accessRequestListHttp: state.list }));

import { GET, POST } from "@/app/api/v1/agent/access-requests/route";

const request = (origin?: string) => new Request("https://node.example/api/v1/agent/access-requests", {
  method: "POST", headers: origin === undefined ? {} : { origin }, body: JSON.stringify({ scope: "x" }),
});
beforeEach(() => {
  state.via = "session"; state.origin = "https://node.example";
  state.ask.mockReset().mockResolvedValue({ status: 201, body: {}, headers: {} });
  state.list.mockReset().mockResolvedValue({ status: 200, body: {}, headers: {} });
});
describe("access requests", () => {
  it.each([undefined, "null", "https://evil.example", "http://node.example", "https://node.example/path"])("rejects session origin %s before asking", async (origin) => {
    expect((await POST(request(origin))).status).toBe(403);
    expect(state.ask).not.toHaveBeenCalled();
  });
  it("accepts the canonical session origin and binds the caller", async () => {
    expect((await POST(request("https://node.example"))).status).toBe(201);
    expect(state.ask.mock.calls[0]?.[1]).toMatchObject({ via: "session", principalUserId: "caller" });
  });
  it("fails closed with no configured origin", async () => {
    state.origin = "";
    expect((await POST(request("https://node.example"))).status).toBe(403);
  });
  it("does not require Origin for bearer POST or session GET", async () => {
    state.via = "bearer";
    expect((await POST(request())).status).toBe(201);
    expect(state.ask.mock.calls[0]?.[1]).toMatchObject({ via: "bearer", principalUserId: "caller" });
    state.via = "session";
    expect((await GET(new Request("https://node.example/api/v1/agent/access-requests"))).status).toBe(200);
    expect(state.list.mock.calls[0]?.[1]).toMatchObject({ via: "session", principalUserId: "caller" });
  });
});
