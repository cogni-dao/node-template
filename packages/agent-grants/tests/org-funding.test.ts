// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/org-funding`
 * Purpose: Who may FUND an account, and what is written when an org is funded. Each test names a way money could land on the wrong account or a refusal could say too much: a spender funding
 *   an org, a suspended org taking money from a non-admin and disclosing it, an unreadable statement read as "not an admin", another person's account (or an unknown one) told apart from a
 *   missing one, and an unbounded payment reference in the history.
 * Scope: Pure over stub lookups and a stub tag. No database.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import { fundingRefusalHttp, orgViewHttp } from "../src/http";
import { type FundingDeps, OrgAccountError, type OrgRole, recordOrgFunded, resolveFundingAccount } from "../src/org-accounts";

const org = (over: Record<string, unknown> = {}) =>
  ({ orgUserId: "org-user", billingAccountId: "acct-org", origin: "https://org.example.com", status: "connected", suspendReason: null, ...over }) as never;

const deps = (opts: { org?: ReturnType<typeof org> | null; role?: OrgRole | null; adminLapsed?: boolean; owner?: string | null } = {}): FundingDeps => ({
  ownAccountId: async (userId) => `acct-of-${userId}`,
  accountOwner: async () => (opts.owner === undefined ? null : opts.owner),
  orgOfAccount: async (id) => (id === "acct-org" ? (opts.org === undefined ? org() : opts.org) : null),
  roleOf: async () => ({ role: opts.role ?? null, adminLapsed: opts.adminLapsed ?? false }),
});

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as OrgAccountError;
  }
  throw new Error("expected a refusal");
};

describe("resolveFundingAccount", () => {
  it("no account named is the person's own, charged in the person's own scope", async () => {
    expect(await resolveFundingAccount(deps(), { userId: "u1" })).toEqual({ billingAccountId: "acct-of-u1", chargeScopeUserId: "u1" });
  });

  it("an org ADMIN funds the org account, in the org's scope", async () => {
    expect(await resolveFundingAccount(deps({ role: "admin" }), { userId: "u1", billingAccountId: "acct-org" })).toEqual({ billingAccountId: "acct-org", chargeScopeUserId: "org-user" });
  });

  it("a spender cannot fund the org: org:spend lets a person spend, never put money on the account", async () => {
    expect((await refusal(resolveFundingAccount(deps({ role: "spend" }), { userId: "u1", billingAccountId: "acct-org" }))).code).toBe("not_allowed");
    expect((await refusal(resolveFundingAccount(deps({ role: null }), { userId: "u1", billingAccountId: "acct-org" }))).code).toBe("not_allowed");
  });

  it("a suspended org refuses an admin with its reason, and tells a non-admin nothing about the suspension", async () => {
    const suspended = org({ status: "suspended", suspendReason: "chargeback" });
    const admin = await refusal(resolveFundingAccount(deps({ org: suspended, role: "admin" }), { userId: "u1", billingAccountId: "acct-org" }));
    expect(admin).toMatchObject({ code: "org_suspended", message: "chargeback" });
    const stranger = await refusal(resolveFundingAccount(deps({ org: suspended, role: null }), { userId: "u2", billingAccountId: "acct-org" }));
    expect(stranger).toMatchObject({ code: "not_allowed" });
    expect(stranger.message).not.toContain("chargeback");
  });

  it("an unreadable statement is statement_unavailable (the person may be an admin), never a plain no, even for a person holding a spend row", async () => {
    expect((await refusal(resolveFundingAccount(deps({ role: null, adminLapsed: true }), { userId: "u1", billingAccountId: "acct-org" }))).code).toBe("statement_unavailable");
    expect((await refusal(resolveFundingAccount(deps({ role: "spend", adminLapsed: true }), { userId: "u1", billingAccountId: "acct-org" }))).code).toBe("statement_unavailable");
  });

  it("an unknown account and another person's account are the same not_allowed, so the answer does not say which exists", async () => {
    const unknown = await refusal(resolveFundingAccount(deps({ owner: null }), { userId: "u1", billingAccountId: "acct-nope" }));
    const theirs = await refusal(resolveFundingAccount(deps({ owner: "someone-else" }), { userId: "u1", billingAccountId: "acct-nope" }));
    expect(unknown).toMatchObject({ code: "not_allowed" });
    expect(theirs).toMatchObject({ code: "not_allowed", message: unknown.message });
  });

  it("the person's own account named outright is allowed in their own scope", async () => {
    expect(await resolveFundingAccount(deps({ owner: "u1" }), { userId: "u1", billingAccountId: "acct-mine" })).toEqual({ billingAccountId: "acct-mine", chargeScopeUserId: "u1" });
  });
});

describe("recordOrgFunded", () => {
  const orgRow = { org_user_id: "org-user", billing_account_id: "acct-org", node_id: "n", origin: "https://org.example.com", admins: [], services: [], statement_version: 1 };
  /** `seen` holds the payment refs already written (the unique index): a repeat inserts no row, as `ON CONFLICT DO NOTHING` does. */
  const tag = (opts: { org?: boolean; actor?: boolean } = {}) => {
    const writes: unknown[][] = [];
    const seen = new Set<string>();
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("FROM org_accounts")) return opts.org === false ? [] : [orgRow];
      if (text.includes("FROM users")) return opts.actor === false ? [] : [{ present: 1 }];
      if (text.includes("INSERT INTO org_events")) {
        expect(text).toContain("ON CONFLICT DO NOTHING");
        expect(text).toContain("'org.funded'");
        const ref = JSON.parse(String(values.find((v) => typeof v === "string" && v.startsWith("{")))).paymentRef as string;
        if (seen.has(ref)) return [];
        seen.add(ref);
        writes.push(values);
        return [{ id: "e1" }];
      }
      return [];
    }) as never;
    return { sql, writes };
  };
  const fund = (sql: never, over: Record<string, unknown> = {}) =>
    recordOrgFunded(sql, { orgBillingAccountId: "acct-org", actorUserId: "admin-1", amountCredits: 5000, paymentRef: "pay_1", ...over } as never);

  it("writes one org.funded row for the org with the amount and the payment ref", async () => {
    const { sql, writes } = tag();
    expect(await fund(sql)).toEqual({ recorded: true, orgUserId: "org-user" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("admin-1");
    expect(JSON.parse(String(writes[0]?.find((v) => typeof v === "string" && v.startsWith("{"))))).toEqual({ amountCredits: 5000, paymentRef: "pay_1" });
  });

  it("the same payment ref twice writes one row and the second answers recorded: false (a repeated webhook never credits the history twice)", async () => {
    const { sql, writes } = tag();
    expect((await fund(sql)).recorded).toBe(true);
    expect((await fund(sql)).recorded).toBe(false);
    expect((await fund(sql, { paymentRef: "pay_2" })).recorded).toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("refuses an empty, blank, oversized or non-printable payment ref instead of truncating it, and writes nothing", async () => {
    const { sql, writes } = tag();
    for (const paymentRef of ["", "   ", "p".repeat(201), "caf\u00e9", "line\nbreak", "tab\there", undefined, 42])
      await expect(fund(sql, { paymentRef })).rejects.toMatchObject({ code: "invalid_payment_ref" });
    expect(writes).toHaveLength(0);
    // The edges that are fine: 200 characters, and surrounding blanks are trimmed (so " a " and "a" are one payment).
    expect((await fund(sql, { paymentRef: "p".repeat(200) })).recorded).toBe(true);
    expect((await fund(sql, { paymentRef: " a " })).recorded).toBe(true);
    expect((await fund(sql, { paymentRef: "a" })).recorded).toBe(false);
  });

  it("refuses an account that is not an org's, and an actor that is no user, and writes nothing", async () => {
    const noOrg = tag({ org: false });
    await expect(fund(noOrg.sql, { orgBillingAccountId: "acct-person" })).rejects.toMatchObject({ code: "not_allowed" });
    const noActor = tag({ actor: false });
    await expect(fund(noActor.sql, { actorUserId: "ghost" })).rejects.toMatchObject({ code: "not_allowed" });
    expect(noOrg.writes).toHaveLength(0);
    expect(noActor.writes).toHaveLength(0);
  });

  it("refuses an amount that is not a positive whole number", async () => {
    const { sql, writes } = tag();
    for (const amountCredits of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) await expect(fund(sql, { amountCredits })).rejects.toMatchObject({ code: "invalid_amount" });
    expect(writes).toHaveLength(0);
  });
});

describe("fundingRefusalHttp", () => {
  it("maps each funding refusal once: 403 not_allowed, 403 org_suspended with the reason, 503 statement_unavailable, 400 for a bad amount or payment ref; anything else is not its to map", () => {
    const of = (code: ConstructorParameters<typeof OrgAccountError>[0], message = "m") => fundingRefusalHttp(new OrgAccountError(code, message));
    expect(of("not_allowed")).toMatchObject({ status: 403, body: { error: "not_allowed" } });
    expect(of("org_suspended", "chargeback")).toMatchObject({ status: 403, body: { error: "org_suspended", reason: "chargeback" } });
    expect(of("statement_unavailable")).toMatchObject({ status: 503, body: { error: "statement_unavailable" } });
    expect(of("invalid_amount")).toMatchObject({ status: 400, body: { error: "invalid_amount" } });
    expect(of("invalid_payment_ref")).toMatchObject({ status: 400, body: { error: "invalid_payment_ref" } });
    expect(of("not_found")).toBeNull();
    expect(fundingRefusalHttp(new Error("x"))).toBeNull();
  });
});

describe("the org view over HTTP", () => {
  const view = (extra: Record<string, unknown>) =>
    ({ orgUserId: "o1", name: "org.example.com", role: "admin", status: "connected", suspendReason: null, balance: 1, canManage: true, adminLapsed: false, people: [], peopleNext: null, history: [], historyNext: null, ...extra }) as never;
  const get = (org: never) => orgViewHttp({ onUnavailable: () => undefined }, { userId: "u1", orgUserId: "o1", authority: { orgView: async () => org } });

  it("passes the billing account id through for an admin, and a spender's answer has none", async () => {
    expect(await get(view({ billingAccountId: "acct-org" }))).toMatchObject({ status: 200, body: { org: { billingAccountId: "acct-org" } } });
    const spender = await get(view({ role: "spend", canManage: false }));
    expect(spender.status).toBe(200);
    expect(JSON.stringify(spender.body)).not.toContain("billingAccountId");
  });
});
