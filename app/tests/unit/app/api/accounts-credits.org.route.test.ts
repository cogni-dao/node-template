// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/accounts-credits.org.route`
 * Purpose: The credits reads of an ORG account (task.0181): after the door allowed, a caller who holds an org role on this account reads through the org owner's scope (row-level security
 *   keys the account on the org's own users id), and anyone else keeps their own scope. Owner, admin, stranger and removed admin, through the real route handler and the real facade.
 * Scope: The real route and facade over a fake container whose account service answers by the database user it was bound to, as row-level security does; no database.
 * Side-effects: none
 */

import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ACCOUNT = "acct-org";
const ORG_USER = "00000000-0000-4000-8000-0000000000a1";

class BillingAccountNotFoundPortError extends Error {
  constructor(id: string) {
    super(`Billing account not found: ${id}`);
    this.name = "BillingAccountNotFoundPortError";
  }
}

const fake = vi.hoisted(() => ({
  caller: "00000000-0000-4000-8000-0000000000b1",
  /** The user ids that hold an org role on the org's account right now. */
  orgRoleHolders: new Set<string>(),
  readAs: [] as string[],
  holdsOrgRole: vi.fn(),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request, user: unknown, context?: unknown) => Promise<NextResponse>) =>
    (request: Request, context?: unknown) =>
      handler({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }, request, { id: fake.caller, via: "session" }, context),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
// The port barrel pulls in the whole app; the facade needs only the name-based guard (the same one the port defines).
vi.mock("@/ports", () => ({
  isBillingAccountNotFoundPortError: (error: unknown) => error instanceof Error && error.name === "BillingAccountNotFoundPortError",
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    agentAuthority: {
      holdsOrgRole: ({ callerUserId, accountId }: { callerUserId: string; accountId: string }) => fake.holdsOrgRole(callerUserId, accountId),
      principalKind: async (userId: string) => (userId === ORG_USER ? "org" : "human"),
    },
    serviceAccountService: {
      getBillingAccountById: async (id: string) => (id === ORG_ACCOUNT ? { id, ownerUserId: ORG_USER } : id === "acct-owner-1" ? { id, ownerUserId: "00000000-0000-4000-8000-0000000000b1" } : null),
    },
    // Row-level security: an account is visible only to the user that owns it.
    accountsForUser: (userId: string) => {
      fake.readAs.push(userId);
      const owns = (accountId: string) => (accountId === ORG_ACCOUNT ? userId === ORG_USER : accountId === "acct-owner-1" ? userId === "00000000-0000-4000-8000-0000000000b1" : false);
      return {
        getBalance: async (accountId: string) => {
          if (!owns(accountId)) throw new BillingAccountNotFoundPortError(accountId);
          return 700;
        },
        listCreditLedgerEntries: async ({ billingAccountId }: { billingAccountId: string }) =>
          owns(billingAccountId) ? [{ id: "00000000-0000-4000-8000-0000000000e1", amount: 700, balanceAfter: 700, reason: "widget_payment", reference: "r1", metadata: null, createdAt: new Date("2026-11-20T00:00:00Z") }] : [],
      };
    },
  }),
}));

import { GET as CREDITS } from "@/app/api/v1/accounts/[accountId]/credits/route";
import { GET as SUMMARY } from "@/app/api/v1/payments/credits/summary/route";

const read = (accountId: string) => CREDITS(new NextRequest(`http://localhost/api/v1/accounts/${accountId}/credits`), { params: Promise.resolve({ accountId }) } as never);

beforeEach(() => {
  fake.caller = "00000000-0000-4000-8000-0000000000b1";
  fake.orgRoleHolders = new Set();
  fake.readAs = [];
  fake.holdsOrgRole.mockImplementation(async (userId: string, accountId: string) => accountId === ORG_ACCOUNT && fake.orgRoleHolders.has(userId));
});

describe("GET /api/v1/accounts/{id}/credits for an org account", () => {
  it("an org admin reads the org's credits, through the org owner's scope", async () => {
    fake.caller = "00000000-0000-4000-8000-0000000000c1";
    fake.orgRoleHolders.add("00000000-0000-4000-8000-0000000000c1");
    const res = await read(ORG_ACCOUNT);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ billingAccountId: ORG_ACCOUNT, balanceCredits: 700, ledger: [{ id: "00000000-0000-4000-8000-0000000000e1" }] });
    // The database user was taken from the account row on the server, never the request.
    expect(fake.readAs).toEqual([ORG_USER]);
  });

  it("an org owner reads it the same way", async () => {
    fake.caller = "00000000-0000-4000-8000-0000000000b2";
    fake.orgRoleHolders.add("00000000-0000-4000-8000-0000000000b2");
    expect((await read(ORG_ACCOUNT)).status).toBe(200);
    expect(fake.readAs).toEqual([ORG_USER]);
  });

  it("a stranger and a removed admin get 404 (they hold no role now), read as themselves, and see nothing", async () => {
    fake.caller = "00000000-0000-4000-8000-0000000000d1";
    const stranger = await read(ORG_ACCOUNT);
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: "not_found" });
    fake.caller = "00000000-0000-4000-8000-0000000000c1";
    fake.orgRoleHolders.add("00000000-0000-4000-8000-0000000000c1");
    expect((await read(ORG_ACCOUNT)).status).toBe(200);
    fake.orgRoleHolders.delete("00000000-0000-4000-8000-0000000000c1"); // removed
    fake.readAs = [];
    expect((await read(ORG_ACCOUNT)).status).toBe(404);
    expect(fake.readAs).toEqual(["00000000-0000-4000-8000-0000000000c1"]);
  });

  it("a person's own account is read as that person, unchanged, and an org role elsewhere does not change whose scope reads it", async () => {
    fake.caller = "00000000-0000-4000-8000-0000000000b1";
    expect((await read("acct-owner-1")).status).toBe(200);
    expect(fake.readAs).toEqual(["00000000-0000-4000-8000-0000000000b1"]);
    fake.orgRoleHolders.add("00000000-0000-4000-8000-0000000000b1"); // 00000000-0000-4000-8000-0000000000b1 is also an org admin, but not on THIS account
    fake.readAs = [];
    expect((await read("acct-owner-1")).status).toBe(200);
    expect(fake.readAs).toEqual(["00000000-0000-4000-8000-0000000000b1"]);
  });
});

describe("GET /api/v1/payments/credits/summary?accountId= for an org account (the same read)", () => {
  const summary = (accountId: string) => SUMMARY(new NextRequest(`http://localhost/api/v1/payments/credits/summary?accountId=${accountId}`), undefined as never);

  it("an org admin reads the org's summary through the org owner's scope; a stranger and a removed admin get 404", async () => {
    fake.caller = "00000000-0000-4000-8000-0000000000c1";
    fake.orgRoleHolders.add(fake.caller);
    const ok = await summary(ORG_ACCOUNT);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ billingAccountId: ORG_ACCOUNT, balanceCredits: 700 });
    expect(fake.readAs).toEqual([ORG_USER]);
    fake.orgRoleHolders.delete(fake.caller); // removed
    expect((await summary(ORG_ACCOUNT)).status).toBe(404);
    fake.caller = "00000000-0000-4000-8000-0000000000d1";
    expect((await summary(ORG_ACCOUNT)).status).toBe(404);
  });
});
