// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/attribution-admin-guard`
 * Purpose: The attribution routes' admin gate is the one admin check (ONE_ADMIN_CHECK), on the caller's BOUND wallets. Defects named: a session whose login
 *   wallet is listed in repo-spec but which has no bound wallet was admitted by the old `checkApprover(sessionUser.walletAddress)`; a bearer with a bound
 *   listed wallet was refused because it has no login wallet; a store outage must be 503, never a pass.
 * Scope: Real `denyUnlessNodeAdmin` and real `createAdminCheck` over a fake `user_bindings` read and a fake roster; no database or network.
 * Side-effects: none
 */

import { describe, expect, it, vi } from "vitest";

import { denyUnlessNodeAdmin } from "@/app/api/v1/attribution/_lib/admin-guard";
import { createAdminCheck } from "@/bootstrap/agent-authority";

const LISTED = "0x070075f1389ae1182abac722b36ca12285d0c949";
const bound = new Map<string, string[]>();
let storeDown = false;

const adminCheck = createAdminCheck(
  ((_strings: TemplateStringsArray, userId: string) =>
    storeDown
      ? Promise.reject(new Error("store down"))
      : Promise.resolve((bound.get(userId) ?? []).map((external_id) => ({ external_id })))) as never,
  { check: async (input) => (input.walletAddress?.toLowerCase() === LISTED ? { ok: true } : { ok: false, errorCode: "authz_denied" }) }
);

vi.mock("@/bootstrap/container", () => ({ getContainer: () => ({ agentAuthority: { adminCheck } }) }));

const ctx = { log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as never;

describe("attribution admin gate is the one admin check", () => {
  it("refuses 403 a session whose login wallet is listed but which has no bound wallet", async () => {
    bound.set("session-user", []);
    // The session's login wallet (LISTED) is not an input: only the user id reaches the check.
    const denied = await denyUnlessNodeAdmin(ctx, { id: "session-user", walletAddress: LISTED } as never);
    expect(denied?.status).toBe(403);
    expect(await denied?.json()).toEqual({ error: "Not authorized as ledger approver" });
  });

  it("allows a bearer whose user has a bound listed wallet and no login wallet", async () => {
    bound.set("agent-key-user", [LISTED.toUpperCase().replace("0X", "0x")]);
    expect(await denyUnlessNodeAdmin(ctx, { id: "agent-key-user" })).toBeNull();
  });

  it("refuses a bound wallet that is not listed", async () => {
    bound.set("other-user", ["0x0000000000000000000000000000000000000001"]);
    expect((await denyUnlessNodeAdmin(ctx, { id: "other-user" }))?.status).toBe(403);
  });

  it("is 503, not a pass, when the bound-wallet read fails", async () => {
    storeDown = true;
    try {
      expect((await denyUnlessNodeAdmin(ctx, { id: "agent-key-user" }))?.status).toBe(503);
    } finally {
      storeDown = false;
    }
  });
});
