// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { accountCreditsReadContract, createAccountCreditsReadImplementation } from "../src/tools/account-credits-read";

describe("core__account_credits_read", () => {
  it("is a read tool with an account-kind scope and takes no account argument", () => {
    expect(accountCreditsReadContract.effect).toBe("read_only");
    expect(accountCreditsReadContract.requires).toMatchObject({ scope: "account:read", kind: "account", subject: "member" });
    expect(accountCreditsReadContract.inputSchema.safeParse({}).success).toBe(true);
    expect(accountCreditsReadContract.inputSchema.safeParse({ accountId: "someone-else" }).success).toBe(false);
  });
  it("returns the balance the capability reads, and one non-disclosing error when it reads nothing", async () => {
    const ok = createAccountCreditsReadImplementation({ accountCreditsCapability: { read: async () => ({ billingAccountId: "a", balanceCredits: 7 }) } });
    await expect(ok.execute({})).resolves.toEqual({ billingAccountId: "a", balanceCredits: 7 });
    const none = createAccountCreditsReadImplementation({ accountCreditsCapability: { read: async () => null } });
    await expect(none.execute({})).rejects.toThrow("account_not_found");
  });
});
