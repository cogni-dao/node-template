// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/org-bill-to`
 * Purpose: ONE_RESOLVER names who pays. Each test names a way money could move wrongly: a person billing an org they hold no role on, a suspended account still paying, a service
 *   that the org's statement no longer enables or that disconnected still paying, a silent fallback to the person's own account after a refused choice, and the run's scope check
 *   opening an org's account to a stranger.
 * Scope: The pure resolver over injected lookups. No database.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import { billToRefusalHttp } from "../src/http";
import { assertOrgChargeable, type BillToDeps, type BillToOrg, billToScopeUserFor, OrgAccountError, type OrgRole, resolveBillTo } from "../src/org-accounts";

type Account = { id: string; ownerUserId: string };
const own: Account = { id: "acct-own", ownerUserId: "person" };
const orgAccount: Account = { id: "acct-org", ownerUserId: "org-user" };
const friend: Account = { id: "acct-friend", ownerUserId: "friend" };
/** An account owned by a legacy repo-spec org: an org principal owns it, but it has no `org_accounts` row. */
const legacyOrgAccount: Account = { id: "acct-legacy", ownerUserId: "legacy-org" };
const org = (status: BillToOrg["status"] = "connected"): BillToOrg => ({ orgUserId: "org-user", billingAccountId: "acct-org", origin: "https://toks5.example.com", status, suspendReason: status === "suspended" ? "abuse" : null });

function deps(over: { org?: BillToOrg; roles?: Record<string, OrgRole>; service?: { userId: string; slug: string }; enabled?: string[]; binding?: string | null; lapsed?: boolean } = {}): BillToDeps<Account> {
  const theOrg = over.org ?? org();
  const accounts: Record<string, Account> = { [own.id]: own, [orgAccount.id]: orgAccount, [friend.id]: friend, [legacyOrgAccount.id]: legacyOrgAccount };
  return {
    payerFor: async () => over.binding ?? null,
    getAccount: async (id) => accounts[id] ?? null,
    orgOfAccount: async (id) => (id === orgAccount.id ? theOrg : null),
    isOrgAccount: async (id) => id === orgAccount.id || id === legacyOrgAccount.id,
    orgOfServicePrincipal: async (userId) => (over.service && over.service.userId === userId ? { org: theOrg, service: over.service.slug } : null),
    roleOf: async (userId) => ({ role: over.roles?.[userId] ?? null, adminLapsed: over.lapsed === true }),
    serviceEnabled: async (_o, slug) => (over.enabled ?? []).includes(slug),
  };
}

describe("resolveBillTo", () => {
  it("bills the org a member with org:spend chose, and reads it in the org's own scope", async () => {
    const result = await resolveBillTo(deps({ roles: { person: "spend" } }), { subjectUserId: "person", own, chosenAccountId: "acct-org" });
    expect(result).toMatchObject({ account: orgAccount, source: "org", chargeScopeUserId: "org-user" });
  });

  it("answers 503, not 'not allowed', when the org's statement cannot be read and the person holds no spend row: the person may well be an admin", async () => {
    await expect(resolveBillTo(deps({ lapsed: true }), { subjectUserId: "person", own, chosenAccountId: "acct-org" })).rejects.toMatchObject({ code: "statement_unavailable" });
    await expect(billToScopeUserFor(deps({ lapsed: true }), { actorUserId: "person", billingAccountId: "acct-org" })).rejects.toMatchObject({ code: "statement_unavailable" });
    // A spender still bills while the statement is down (their role is a row, not the statement).
    expect(await resolveBillTo(deps({ lapsed: true, roles: { person: "spend" } }), { subjectUserId: "person", own, chosenAccountId: "acct-org" })).toMatchObject({ source: "org" });
    expect(billToRefusalHttp(new OrgAccountError("statement_unavailable", "x"))).toMatchObject({ status: 503, body: { error: "statement_unavailable" } });
  });

  it("refuses a chosen org the person holds no role on, never falling back to another payer", async () => {
    await expect(resolveBillTo(deps(), { subjectUserId: "person", own, chosenAccountId: "acct-org" })).rejects.toMatchObject({ code: "not_allowed" });
    await expect(resolveBillTo(deps(), { subjectUserId: "person", own, chosenAccountId: "acct-unknown" })).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("refuses a suspended org even for its admin", async () => {
    const run = resolveBillTo(deps({ org: org("suspended"), roles: { person: "admin" } }), { subjectUserId: "person", own, chosenAccountId: "acct-org" });
    await expect(run).rejects.toBeInstanceOf(OrgAccountError);
    await expect(run).rejects.toMatchObject({ code: "org_suspended" });
  });

  it("bills the org of a calling service while the org's statement enables that service and the org is connected", async () => {
    const service = { userId: "svc", slug: "node-ai" };
    expect(await resolveBillTo(deps({ service, enabled: ["node-ai"] }), { subjectUserId: "svc", own })).toMatchObject({ account: orgAccount, source: "service" });
  });

  it("refuses a calling service explicitly when the org disconnected, dropped that service from its statement or is suspended, and never falls through to the service's own account", async () => {
    const service = { userId: "svc", slug: "node-ai" };
    // Removed from the statement (or the statement is unreadable): the service stops, it is not billed to its own account.
    await expect(resolveBillTo(deps({ service, enabled: [] }), { subjectUserId: "svc", own })).rejects.toMatchObject({ code: "org_disconnected" });
    // Disconnected: its services stop at the next call.
    await expect(resolveBillTo(deps({ org: org("disconnected"), service, enabled: ["node-ai"] }), { subjectUserId: "svc", own })).rejects.toMatchObject({ code: "org_disconnected" });
    await expect(resolveBillTo(deps({ org: org("suspended"), service, enabled: ["node-ai"] }), { subjectUserId: "svc", own })).rejects.toMatchObject({ code: "org_suspended" });
  });

  it("keeps a person's own account and a live payer binding to a person's account as the last two choices", async () => {
    expect(await resolveBillTo(deps(), { subjectUserId: "person", own })).toMatchObject({ account: own, source: "own", chargeScopeUserId: "person" });
    expect(await resolveBillTo(deps({ binding: "acct-friend" }), { subjectUserId: "person", own })).toMatchObject({ account: friend, source: "binding" });
  });

  it("refuses an old payer binding that names an ORG account, connected or legacy repo-spec, instead of billing it or silently billing another payer", async () => {
    await expect(resolveBillTo(deps({ binding: "acct-org" }), { subjectUserId: "person", own })).rejects.toMatchObject({ code: "not_allowed" });
    await expect(resolveBillTo(deps({ binding: "acct-legacy" }), { subjectUserId: "person", own })).rejects.toMatchObject({ code: "not_allowed" });
    await expect(billToScopeUserFor(deps({ binding: "acct-legacy" }), { actorUserId: "person", billingAccountId: "acct-legacy" })).rejects.toMatchObject({ code: "not_allowed" });
  });
});

describe("billToScopeUserFor", () => {
  const input = { actorUserId: "person", billingAccountId: "acct-org" };

  it("opens the org's account scope only to an entitled actor, so a stranger cannot charge it", async () => {
    expect(await billToScopeUserFor(deps({ roles: { person: "spend" } }), input)).toBe("org-user");
    expect(await billToScopeUserFor(deps(), input)).toBe("person");
  });

  it("stops a run on a suspended org account at its own scope check, not only at the choice", async () => {
    await expect(billToScopeUserFor(deps({ org: org("suspended"), roles: { person: "admin" } }), input)).rejects.toMatchObject({ code: "org_suspended" });
  });

  it("opens the org's account to its enabled calling service and to nobody else", async () => {
    const service = { userId: "svc", slug: "node-ai" };
    expect(await billToScopeUserFor(deps({ service, enabled: ["node-ai"] }), { actorUserId: "svc", billingAccountId: "acct-org" })).toBe("org-user");
    await expect(billToScopeUserFor(deps({ service, enabled: [] }), { actorUserId: "svc", billingAccountId: "acct-org" })).rejects.toMatchObject({ code: "org_disconnected" });
    expect(await billToScopeUserFor(deps({ service: { userId: "other-svc", slug: "x" }, enabled: ["x"] }), { actorUserId: "stranger", billingAccountId: "acct-org" })).toBe("stranger");
  });
});

describe("billToRefusalHttp", () => {
  it("answers a suspended org and a refused choice as 403 with their own code (never a 500 or a silent other payer) and ignores every other error", () => {
    expect(billToRefusalHttp(new OrgAccountError("org_suspended", "chargeback"))).toMatchObject({ status: 403, body: { error: "org_suspended", reason: "chargeback" } });
    expect(billToRefusalHttp(new OrgAccountError("not_allowed", "x"))).toMatchObject({ status: 403, body: { error: "bill_to_not_allowed" } });
    expect(billToRefusalHttp(new OrgAccountError("org_disconnected", "gone"))).toMatchObject({ status: 403, body: { error: "org_disconnected" } });
    expect(billToRefusalHttp(new OrgAccountError("not_found", "x"))).toBeNull();
    expect(billToRefusalHttp(new Error("db down"))).toBeNull();
  });
});

describe("the charge point", () => {
  it("reads only the suspension (two columns), not the whole account row, on every model call", async () => {
    const seen: string[] = [];
    const tag = (rows: Array<Record<string, unknown>>) =>
      (async (strings: TemplateStringsArray) => {
        seen.push(strings.join("?"));
        return rows;
      }) as never;
    await expect(assertOrgChargeable(tag([{ suspended_at: new Date(), suspend_reason: "chargeback" }]), "acct-1")).rejects.toMatchObject({ code: "org_suspended", message: "chargeback" });
    await expect(assertOrgChargeable(tag([{ suspended_at: null, suspend_reason: null }]), "acct-1")).resolves.toBeUndefined();
    await expect(assertOrgChargeable(tag([]), "acct-1")).resolves.toBeUndefined();
    for (const text of seen) {
      expect(text).toContain("suspended_at, suspend_reason");
      expect(text).not.toMatch(/admins|services|statement_version/);
    }
  });
});
