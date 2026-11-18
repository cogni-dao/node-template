// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/attribution-admin-before-epoch-read`
 * Purpose: Defect: sign-data, finalize and distribution-tx loaded the epoch before the admin check, so a non-admin got 404 for a missing epoch and
 *   403 for a real one, which leaks which epoch ids exist. The one admin check must run first, so a non-admin gets 403 for a nonexistent id.
 * Scope: The real route handlers with the route wrapper, the container and the settlement runtime faked; no database or network.
 * Side-effects: none
 */

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  getEpoch: vi.fn(async () => null),
  adminCheck: vi.fn(async () => "denied"),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    attributionStore: { getEpoch: fake.getEpoch },
    agentAuthority: { adminCheck: fake.adminCheck },
  }),
  finalizeEpochInProcess: vi.fn(),
}));
vi.mock("@/bootstrap/settlement-runtime", () => ({ readLiveDistributionMerkleRoot: vi.fn() }));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_options: unknown, handler: (ctx: unknown, request: Request, user: unknown, context: unknown) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      handler({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }, request, { id: "not-an-admin", walletAddress: "0xlisted-login-wallet" }, context),
}));

import { POST as finalize } from "@/app/api/v1/attribution/epochs/[id]/finalize/route";
import { GET as distributionTx } from "@/app/api/v1/attribution/epochs/[id]/distribution-tx/route";
import { GET as signData } from "@/app/api/v1/attribution/epochs/[id]/sign-data/route";

const params = { params: Promise.resolve({ id: "999999999" }) };

describe("attribution epoch routes: admin check before any epoch read", () => {
  it.each([
    ["sign-data", () => signData(new NextRequest("http://x/sign-data"), params)],
    ["finalize", () => finalize(new NextRequest("http://x/finalize", { method: "POST", body: "{}" }), params)],
    ["distribution-tx", () => distributionTx(new NextRequest("http://x/distribution-tx"), params)],
  ])("%s: a non-admin gets 403 for a nonexistent epoch, never 404", async (_name, call) => {
    fake.getEpoch.mockClear();
    const res = await call();
    expect(res.status).toBe(403);
    expect(fake.getEpoch).not.toHaveBeenCalled();
  });
});
