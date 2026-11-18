// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/identity-payout.route`
 * Purpose: The payout routes keep each plane to its own credential, and a caller can only touch its own row. Each case names the defect it prevents.
 * Scope: The three route files with the facade replaced by recorders; no database.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY; KIND_PICKS_THE_PLANE; OWN_ROW_ONLY; BENEFICIARY_IS_ACCEPTED.
 * Side-effects: none
 * @internal
 */

import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  user: null as unknown,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  facade: {
    getPayoutAddress: vi.fn(async () => null),
    setPayoutAddress: vi.fn(async () => undefined),
    proposeBeneficiary: vi.fn(async () => ({ status: "pending", token: "tok", expiresAt: new Date("2026-12-01T00:00:00Z") })),
    beneficiaryStatus: vi.fn(),
    acceptBeneficiary: vi.fn(async () => true),
    listMineBeneficiaries: vi.fn(async () => []),
    revokeBeneficiary: vi.fn(async () => true),
  },
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request, user: unknown) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: fake.log }, request, fake.user),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => fake.user) }));
vi.mock("@/app/_facades/identity/payout.server", () => fake.facade);
vi.mock("@/bootstrap/settlement-runtime", () => ({ reconcilePendingSettlements: vi.fn(async () => ({ status: "noop" })) }));

import { DELETE as withdraw, POST as propose } from "@/app/api/v1/identity/beneficiary/route";
import { POST as accept } from "@/app/api/v1/identity/beneficiary/mine/route";
import { PUT as setAddress } from "@/app/api/v1/identity/payout-address/route";

const as = (id: string, via: "session" | "bearer") => {
  fake.user = { id, walletAddress: null, displayName: null, avatarColor: null, via };
};
const req = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe("payout routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("an AI key cannot accept a beneficiary (defect: an AI accepted its own proposal and named itself or a friend)", async () => {
    as("agent-1", "bearer");
    const res = await accept(req("/api/v1/identity/beneficiary/mine", "POST", { token: "tok" }, { authorization: "Bearer key" }));
    expect(res.status).toBe(403);
    expect(fake.facade.acceptBeneficiary).not.toHaveBeenCalled();
  });

  it("an AI key cannot set a payout address (defect: an AI pointed its own earnings at a wallet)", async () => {
    as("agent-1", "bearer");
    const res = await setAddress(req("/api/v1/identity/payout-address", "PUT", { address: `0x${"a".repeat(40)}` }, { authorization: "Bearer key" }));
    expect(res.status).toBe(403);
    expect(fake.facade.setPayoutAddress).not.toHaveBeenCalled();
  });

  it("a browser session cannot propose or withdraw on the AI plane", async () => {
    as("human-1", "session");
    expect((await propose(req("/api/v1/identity/beneficiary", "POST"))).status).toBe(404);
    expect((await withdraw(req("/api/v1/identity/beneficiary", "DELETE"))).status).toBe(404);
    expect(fake.facade.proposeBeneficiary).not.toHaveBeenCalled();
  });

  it("an AI proposes for itself only: the earner is the caller, whatever the body says, and the link carries the token in the fragment", async () => {
    as("agent-1", "bearer");
    const res = await propose(req("/api/v1/identity/beneficiary", "POST", { earnerUserId: "someone-else" }));
    expect(fake.facade.proposeBeneficiary).toHaveBeenCalledWith("agent-1");
    const body = (await res.json()) as { approvalUrl: string };
    expect(body.approvalUrl).toBe("http://localhost/profile#beneficiary=tok");
  });

  it("the signed-in person becomes the beneficiary: the accept uses the session id, never one from the body", async () => {
    as("human-1", "session");
    await accept(req("/api/v1/identity/beneficiary/mine", "POST", { token: "tok" }));
    expect(fake.facade.acceptBeneficiary).toHaveBeenCalledWith("human-1", "tok");
  });

  it("a payout address is validated and stored lowercase, on the caller's own row", async () => {
    as("human-1", "session");
    const checksummed = "0x52908400098527886E0F7030069857D2E4169EE7";
    const bad = await setAddress(req("/api/v1/identity/payout-address", "PUT", { address: "not-an-address" }));
    expect(bad.status).toBe(400);
    const ok = await setAddress(req("/api/v1/identity/payout-address", "PUT", { address: checksummed }));
    expect(ok.status).toBe(200);
    expect(fake.facade.setPayoutAddress).toHaveBeenCalledWith("human-1", checksummed.toLowerCase());
  });
});
