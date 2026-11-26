// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/payments/funding-account`
 * Purpose: Defects guarded: a person who is not an org admin funds an org account; the caller's own top-up starts asking identity or writes under another scope.
 * Scope: `resolvePaymentAccount` over a fake container; identity's decision itself is tested in agent-grants.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/org-funding-design
 * @public
 */

import { OrgAccountError } from "@cogni/agent-grants/org-accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreate = vi.fn();
vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: (...args: unknown[]) => getOrCreate(...args),
}));

import { resolvePaymentAccount } from "@/app/_facades/payments/funding-account.server";
import type { Container } from "@/bootstrap/container";

const PERSON = "11111111-1111-4111-8111-111111111111";
const ORG_USER = "22222222-2222-4222-8222-222222222222";
const session = { id: PERSON, walletAddress: "0x070075F1389Ae1182aBac722B36CA12285d0c949" };

function fakeContainer(resolveFundingAccount: ReturnType<typeof vi.fn>) {
  return {
    accountsForUser: vi.fn((userId: string) => ({ scope: userId })),
    agentAuthority: { resolveFundingAccount },
  } as unknown as Container;
}

describe("resolvePaymentAccount", () => {
  beforeEach(() => getOrCreate.mockReset());

  it("funds the caller's own account without asking identity", async () => {
    const resolve = vi.fn();
    getOrCreate.mockResolvedValue({ id: "ba-own", defaultVirtualKeyId: "vk-own" });
    const out = await resolvePaymentAccount(fakeContainer(resolve), session as never, undefined);
    expect(resolve).not.toHaveBeenCalled();
    expect(out).toMatchObject({ rlsUserId: PERSON, billingAccount: { id: "ba-own" }, orgFunding: false });
  });

  it("funds an org account under the org user's scope when identity admits the caller", async () => {
    const resolve = vi.fn().mockResolvedValue({ billingAccountId: "ba-org", chargeScopeUserId: ORG_USER });
    getOrCreate.mockResolvedValue({ id: "ba-org", defaultVirtualKeyId: "vk-org" });
    const container = fakeContainer(resolve);
    const out = await resolvePaymentAccount(container, session as never, "ba-org");
    expect(resolve).toHaveBeenCalledWith({ userId: PERSON, billingAccountId: "ba-org" });
    expect(container.accountsForUser).toHaveBeenCalledWith(ORG_USER);
    expect(out).toMatchObject({ rlsUserId: ORG_USER, billingAccount: { id: "ba-org" }, orgFunding: true });
  });

  it("refuses a caller identity refuses (not an org admin), before any account is read", async () => {
    const resolve = vi.fn().mockRejectedValue(new OrgAccountError("not_allowed", "not allowed"));
    await expect(resolvePaymentAccount(fakeContainer(resolve), session as never, "ba-org")).rejects.toBeInstanceOf(OrgAccountError);
    expect(getOrCreate).not.toHaveBeenCalled();
  });
});
