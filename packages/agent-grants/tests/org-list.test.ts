// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/org-list`
 * Purpose: "Your orgs" runs on every page of the account menu, so its cost is bounded. Each test names a cost or a lie: one database query per listed org, a cut list that does not say it is cut,
 *   and an admin shown from a stale stored list instead of the org's current statement.
 * Scope: Pure over a counting stub tag and a stub statement reader. No database, no network.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import { listMyOrgs } from "../src/org-accounts";
import { OwnerSourceUnavailableError } from "../src/orgs";

const WALLET = "0x00000000000000000000000000000000000000a1";
const row = (i: number, spends = false) => ({
  org_user_id: `org-${i}`,
  billing_account_id: `acct-${i}`,
  node_id: `node-${i}`,
  origin: `https://org${String(i).padStart(3, "0")}.example.com`,
  dao: null,
  admins: [WALLET],
  services: [],
  statement_version: 1,
  statement_commit: null,
  disconnected_at: null,
  suspended_at: null,
  suspend_reason: null,
  balance_credits: 10 + i,
  spends,
});

const counting = (candidates: Array<Record<string, unknown>>) => {
  const queries: string[] = [];
  const tag = (async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text);
    return text.includes("FROM user_bindings") ? [{ external_id: WALLET }] : candidates;
  }) as never;
  return { tag, queries };
};

describe("listMyOrgs", () => {
  it("reads 101 candidate orgs as 100 and returns the cursor of the next page (the origin), with two database queries in all (no query per org)", async () => {
    const { tag, queries } = counting(Array.from({ length: 101 }, (_, i) => row(i)));
    const result = await listMyOrgs(tag, async () => [WALLET], "person");
    expect(result.orgs).toHaveLength(100);
    expect(result.next).toBe(`https://org099.example.com`);
    expect(queries).toHaveLength(2);
    expect(result.orgs[0]).toMatchObject({ role: "admin", balance: 10 });
  });

  it("reads at most five org statements at a time, so a cold cache does not open a hundred connections at once", async () => {
    const { tag } = counting(Array.from({ length: 40 }, (_, i) => row(i)));
    let inFlight = 0;
    let peak = 0;
    const adminsOf = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return [WALLET];
    };
    const result = await listMyOrgs(tag, adminsOf, "person");
    expect(result.orgs).toHaveLength(40);
    expect(result.orgs.map((o) => o.name)).toEqual(Array.from({ length: 40 }, (_, i) => `org${String(i).padStart(3, "0")}.example.com`));
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("is not cut at exactly 100 orgs", async () => {
    const { tag } = counting(Array.from({ length: 100 }, (_, i) => row(i)));
    expect((await listMyOrgs(tag, async () => [WALLET], "person")).next).toBeNull();
  });

  it("decides admin from the org's CURRENT statement, not the stored list: a removed approver is not listed, and a spend row still is", async () => {
    const { tag } = counting([row(1), row(2, true)]);
    const result = await listMyOrgs(tag, async () => ["0x00000000000000000000000000000000000000b2"], "person");
    expect(result.orgs.map((o) => [o.orgUserId, o.role])).toEqual([["org-2", "spend"]]);
  });

  it("lapses only the admin role when a statement is unreadable: a spender is still listed", async () => {
    const { tag } = counting([row(1), row(2, true)]);
    const result = await listMyOrgs(tag, async () => Promise.reject(new OwnerSourceUnavailableError("unreachable")), "person");
    expect(result.orgs.map((o) => [o.orgUserId, o.role])).toEqual([["org-2", "spend"]]);
  });
});
