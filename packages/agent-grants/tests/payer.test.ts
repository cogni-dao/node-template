// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  approveAccountAsk,
  authorizeAccount,
  denyAccountAsk,
  hashLinkToken,
  newLinkToken,
  payerScopeUserFor,
  revokeAccountRow,
  selectRunPayer,
} from "../src";
import { type OrgSource, OwnerSourceUnavailableError } from "../src/orgs";
import { memoryStore } from "./memory-store";

const SRC: OrgSource = { kind: "repo-spec", ref: "https://github.com/cogni-dao/toks5" };
const owners = (list: string[]) => ({ owners: async () => list });
const down = { owners: async () => Promise.reject(new OwnerSourceUnavailableError("down")) };

describe("org account decisions (approve, deny, revoke a grant row)", () => {
  const ASK_SCOPE = "account:read";
  /** An outside agent's pending ACCOUNT ask with a real link token. */
  const asked = async (store: ReturnType<typeof memoryStore>, principal: string) => {
    const token = newLinkToken();
    await store.requestRole({
      principalUserId: principal,
      scope: ASK_SCOPE,
      resource: "account",
      link: { hash: await hashLinkToken(token), expiresAt: new Date(store.clock.now + 60_000) },
      maxPending: 3,
      maxPendingTotal: 50,
    });
    return token;
  };
  const org = () => memoryStore({ accounts: { org1: "acct-org", alice: "acct-alice" }, orgAccounts: { "acct-org": SRC } });
  const me = (userId: string) => ({ userId, admin: null });

  it("an owner of the org approves an ask onto the org's account, and the grant then authorizes the agent", async () => {
    const store = org();
    const token = await asked(store, "agent");
    expect((await approveAccountAsk(store, { me: me("bob"), token, accountId: "acct-org", owners: owners(["bob"]) })).approved).toBe(true);
    expect(store.roles[0]).toMatchObject({ accountId: "acct-org", approvedBy: "bob", expiresAt: null });
    expect(await authorizeAccount(store, { via: "bearer", callerUserId: "agent", scope: ASK_SCOPE, accountId: "acct-org" })).toBe("delegated");
  });

  it("a non-owner is refused, a person's account is never approved through the org statement, and a down owner source refuses", async () => {
    const store = org();
    const token = await asked(store, "agent");
    await expect(approveAccountAsk(store, { me: me("dave"), token, accountId: "acct-org", owners: owners(["bob"]) })).rejects.toMatchObject({ code: "not_allowed" });
    await expect(approveAccountAsk(store, { me: me("bob"), token, accountId: "acct-org", owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    // bob owns no person's account: naming alice's account through the org door is refused too.
    await expect(approveAccountAsk(store, { me: me("bob"), token, accountId: "acct-alice", owners: owners(["bob"]) })).rejects.toMatchObject({ code: "not_allowed" });
    // Without an accountId the old behavior is byte-for-byte: bob owns no account, so he is refused.
    await expect(approveAccountAsk(store, { me: me("bob"), token, owners: owners(["bob"]) })).rejects.toMatchObject({ code: "not_allowed" });
    expect(store.roles[0]?.approvedBy ?? null).toBeNull();
  });

  it("an owner who is the asking agent is refused (NO_SELF_APPROVAL)", async () => {
    const store = org();
    const token = await asked(store, "bob");
    await expect(approveAccountAsk(store, { me: me("bob"), token, accountId: "acct-org", owners: owners(["bob"]) })).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("an owner of the org denies an ask, and revokes a live row by id; a non-owner sees nothing", async () => {
    const store = org();
    const denied = await asked(store, "agent");
    expect((await denyAccountAsk(store, { me: me("bob"), token: denied, accountId: "acct-org", owners: owners(["bob"]) })).denied).toBe(true);
    expect(store.roles[0]?.revoked).toBe(true);

    const token = await asked(store, "agent2");
    await approveAccountAsk(store, { me: me("bob"), token, accountId: "acct-org", owners: owners(["bob"]) });
    const row = store.roles.find((r) => r.principal === "agent2");
    expect(row?.approvedBy).toBe("bob");
    // A stranger, and an owner while the source is unreadable, change nothing.
    expect((await revokeAccountRow(store, { me: me("dave"), rowId: row?.id as string, owners: owners(["bob"]) })).revoked).toBe(false);
    await expect(revokeAccountRow(store, { me: me("bob"), rowId: row?.id as string, owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(row?.revoked).toBe(false);
    expect((await revokeAccountRow(store, { me: me("carol"), rowId: row?.id as string, owners: owners(["bob", "carol"]) })).revoked).toBe(true);
    expect(row?.revoked).toBe(true);
  });

  it("with the owner source down, a live grant still authorizes the agent and an org owner's read is refused", async () => {
    const store = org();
    const token = await asked(store, "agent");
    await approveAccountAsk(store, { me: me("bob"), token, accountId: "acct-org", owners: owners(["bob"]) });
    // A live grant never waits on the owner read (OWNERS_READ_AT_DECISION): the call reads the grant row alone.
    expect(await authorizeAccount(store, { via: "bearer", callerUserId: "agent", scope: ASK_SCOPE, accountId: "acct-org", owners: down })).toBe("delegated");
    // An owner reading through the source is refused while it is unreadable, never allowed.
    await expect(authorizeAccount(store, { via: "session", callerUserId: "bob", scope: ASK_SCOPE, accountId: "acct-org", owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("a human-owned account keeps its own statement: the owner revokes without any owner source", async () => {
    const store = org();
    store.roles.push({ id: "r-h", principal: "agent", scope: ASK_SCOPE, revoked: false, approvedBy: "alice", resource: "account", accountId: "acct-alice", grantedAt: 1, expiresAt: null, revokedAt: null, linkHash: null, linkExpiresAt: null, linkConsumed: false, seq: 99 });
    expect((await revokeAccountRow(store, { me: me("alice"), rowId: "r-h" })).revoked).toBe(true);
  });
});

describe("selectRunPayer and payerScopeUserFor (pure run-path decisions)", () => {
  const OWN = { id: "acct-svc", ownerUserId: "svc" };
  const ORG = { id: "acct-org", ownerUserId: "org1" };
  const deps = (bound: string | null | Error) => ({
    payerFor: vi.fn(async () => {
      if (bound instanceof Error) throw bound;
      return bound;
    }),
    getAccount: vi.fn(async (id: string) => ({ [ORG.id]: ORG, [OWN.id]: OWN })[id] ?? null),
  });

  it("bills the bound account only for a live binding that names another, existing account", async () => {
    expect(await selectRunPayer(deps(ORG.id), { subjectUserId: "svc", own: OWN })).toEqual({ account: ORG, bound: true });
    const none = deps(null);
    expect(await selectRunPayer(none, { subjectUserId: "svc", own: OWN })).toEqual({ account: OWN, bound: false });
    expect(none.getAccount).not.toHaveBeenCalled();
    expect((await selectRunPayer(deps(OWN.id), { subjectUserId: "svc", own: OWN })).bound).toBe(false);
    expect(await selectRunPayer(deps("acct-gone"), { subjectUserId: "svc", own: OWN })).toEqual({ account: OWN, bound: false });
  });

  it("a failed binding read throws, so no run starts on a guessed payer", async () => {
    await expect(selectRunPayer(deps(new Error("db down")), { subjectUserId: "svc", own: OWN })).rejects.toThrow("db down");
  });

  it("the run reads the bound account in its owner's scope only when the actor's live binding names exactly that account", async () => {
    expect(await payerScopeUserFor(deps(ORG.id), { actorUserId: "svc", billingAccountId: ORG.id })).toBe("org1");
    const own = deps(ORG.id);
    expect(await payerScopeUserFor(own, { actorUserId: "svc", billingAccountId: OWN.id })).toBe("svc");
    expect(own.payerFor).not.toHaveBeenCalled();
    expect(await payerScopeUserFor(deps(null), { actorUserId: "svc", billingAccountId: ORG.id })).toBe("svc");
    expect(await payerScopeUserFor(deps("acct-other"), { actorUserId: "svc", billingAccountId: ORG.id })).toBe("svc");
    expect(await payerScopeUserFor(deps(ORG.id), { actorUserId: "svc", billingAccountId: "acct-gone" })).toBe("svc");
  });
});
