// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  AgentRolesError,
  approveAccountAsk,
  authorizeAccount,
  decidePayerBinding,
  denyAccountAsk,
  hashLinkToken,
  MAX_PENDING_PER_ACCOUNT,
  newLinkToken,
  ownersForBinding,
  PENDING_BINDING_TTL_DAYS,
  payerFor,
  payerScopeUserFor,
  requestPayerBinding,
  revokeAccountRow,
  revokePayerBinding,
  selectRunPayer,
} from "../src";
import { type OrgSource, OwnerSourceUnavailableError } from "../src/orgs";
import { memoryStore } from "./memory-store";
import { memoryPayerStore } from "./payer-store";

const SRC: OrgSource = { kind: "repo-spec", ref: "https://github.com/cogni-dao/toks5" };
const owners = (list: string[]) => ({ owners: async () => list });
const down = { owners: async () => Promise.reject(new OwnerSourceUnavailableError("down")) };

// acct-org belongs to the org user `org1` (owners: bob, carol); acct-alice to the person alice. `svc` is a service principal from another node.
const fixture = () => {
  const grants = memoryStore({ accounts: { org1: "acct-org", alice: "acct-alice" }, orgAccounts: { "acct-org": SRC } });
  const payer = memoryPayerStore({ accounts: { "acct-org": "org1", "acct-alice": "alice" }, orgAccounts: ["acct-org"] });
  const me = (userId: string) => ({ userId, admin: null });
  return { grants, payer, me };
};

describe("payer binding lifecycle", () => {
  it("an ask names no payer until an owner of the org approves; Off ends it", async () => {
    const { grants, payer, me } = fixture();
    const ask = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    expect(ask).toMatchObject({ state: "pending", created: true });
    expect(await payerFor(payer, "svc")).toBeNull();

    const decided = await decidePayerBinding(payer, grants, { me: me("bob"), id: ask.id, approve: true, owners: owners(["bob", "carol"]) });
    expect(decided).toMatchObject({ decided: true, subjectUserId: "svc", billingAccountId: "acct-org" });
    expect(await payerFor(payer, "svc")).toBe("acct-org");

    // Off by another owner: the very next read names no payer.
    const off = await revokePayerBinding(payer, grants, { me: me("carol"), id: ask.id, owners: owners(["bob", "carol"]) });
    expect(off.revoked).toBe(true);
    expect(await payerFor(payer, "svc")).toBeNull();
    // A closed binding is invisible: a second Off and a late approve change nothing.
    expect((await revokePayerBinding(payer, grants, { me: me("bob"), id: ask.id, owners: owners(["bob"]) })).revoked).toBe(false);
    expect((await decidePayerBinding(payer, grants, { me: me("bob"), id: ask.id, approve: true, owners: owners(["bob"]) })).decided).toBe(false);
  });

  it("a non-owner is refused on approve, deny and revoke; an admin session adds nothing", async () => {
    const { grants, payer, me } = fixture();
    const { id } = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    const stranger = { userId: "dave", admin: {} };
    for (const approve of [true, false])
      await expect(decidePayerBinding(payer, grants, { me: stranger, id, approve, owners: owners(["bob"]) })).rejects.toMatchObject({ code: "not_allowed" });
    await expect(revokePayerBinding(payer, grants, { me: stranger, id, owners: owners(["bob"]) })).rejects.toMatchObject({ code: "not_allowed" });
    expect(await payerFor(payer, "svc")).toBeNull();
    // Without owner sources an org account has no approver but its own user.
    await expect(decidePayerBinding(payer, grants, { me: me("bob"), id, approve: true })).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("the subject cannot approve its own binding even when it is an owner (NO_SELF_APPROVAL)", async () => {
    const { grants, payer, me } = fixture();
    const { id } = await requestPayerBinding(payer, { subjectUserId: "bob", billingAccountId: "acct-org" });
    await expect(decidePayerBinding(payer, grants, { me: me("bob"), id, approve: true, owners: owners(["bob"]) })).rejects.toBeInstanceOf(AgentRolesError);
    await expect(decidePayerBinding(payer, grants, { me: me("bob"), id, approve: true, owners: owners(["bob"]) })).rejects.toMatchObject({ code: "self_approval" });
    expect(await payerFor(payer, "bob")).toBeNull();
  });

  it("a person's own account is decided by that person alone", async () => {
    const { grants, payer, me } = fixture();
    const { id } = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-alice" });
    await expect(decidePayerBinding(payer, grants, { me: me("bob"), id, approve: true, owners: owners(["bob"]) })).rejects.toMatchObject({ code: "not_allowed" });
    expect((await decidePayerBinding(payer, grants, { me: me("alice"), id, approve: true, owners: down })).decided).toBe(true);
    expect(await payerFor(payer, "svc")).toBe("acct-alice");
  });

  it("an unavailable owner source refuses an org decision by throwing, and never changes a live binding", async () => {
    const { grants, payer, me } = fixture();
    const { id } = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    await expect(decidePayerBinding(payer, grants, { me: me("bob"), id, approve: true, owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(await payerFor(payer, "svc")).toBeNull();
    await decidePayerBinding(payer, grants, { me: me("bob"), id, approve: true, owners: owners(["bob"]) });
    // Calls read the binding row alone: the owner source being down does not touch payerFor.
    expect(await payerFor(payer, "svc")).toBe("acct-org");
    await expect(revokePayerBinding(payer, grants, { me: me("bob"), id, owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(await payerFor(payer, "svc")).toBe("acct-org");
  });

  it("one open binding per subject: the same account is idempotent, a pending ask is replaced, a live one must be turned Off first", async () => {
    const { grants, payer, me } = fixture();
    const first = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    const again = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    expect(again).toMatchObject({ id: first.id, created: false });
    const other = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-alice" });
    expect(other.id).not.toBe(first.id);
    expect(payer.rows.filter((b) => !b.revoked)).toHaveLength(1);

    await decidePayerBinding(payer, grants, { me: me("alice"), id: other.id, approve: true });
    await expect(requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" })).rejects.toMatchObject({ code: "not_allowed" });
    expect(await payerFor(payer, "svc")).toBe("acct-alice");
    await expect(requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "nope" })).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("an unknown account answers like a known one (a pending id) and writes no row", async () => {
    const { payer } = fixture();
    const known = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    const unknown = await requestPayerBinding(payer, { subjectUserId: "svc2", billingAccountId: "no-such-account" });
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
    expect(unknown).toMatchObject({ state: "pending", created: true });
    expect(unknown.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payer.rows.filter((b) => b.subject === "svc2")).toHaveLength(0);
    expect(await payerFor(payer, "svc2")).toBeNull();
  });

  it("an account holds at most MAX_PENDING_PER_ACCOUNT pending asks; another account is unaffected, and a subject holds one", async () => {
    const { grants, payer, me } = fixture();
    for (let i = 0; i < MAX_PENDING_PER_ACCOUNT; i++) await requestPayerBinding(payer, { subjectUserId: `s${i}`, billingAccountId: "acct-org" });
    await expect(requestPayerBinding(payer, { subjectUserId: "one-more", billingAccountId: "acct-org" })).rejects.toMatchObject({ code: "too_many_requests" });
    // The same subject asking again is the same row, not a second ask.
    expect((await requestPayerBinding(payer, { subjectUserId: "s0", billingAccountId: "acct-org" })).created).toBe(false);
    // Another account has its own count.
    expect((await requestPayerBinding(payer, { subjectUserId: "one-more", billingAccountId: "acct-alice" })).created).toBe(true);
    // A decided ask frees a slot.
    const first = payer.rows[0]?.id as string;
    await decidePayerBinding(payer, grants, { me: me("bob"), id: first, approve: false, owners: owners(["bob"]) });
    expect((await requestPayerBinding(payer, { subjectUserId: "late", billingAccountId: "acct-org" })).created).toBe(true);
  });

  it("a pending ask expires after the TTL: it is not counted, cannot be decided, and the subject's next ask replaces it", async () => {
    const { grants, payer, me } = fixture();
    const day = 86_400_000;
    const old = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    for (let i = 0; i < MAX_PENDING_PER_ACCOUNT - 1; i++) await requestPayerBinding(payer, { subjectUserId: `s${i}`, billingAccountId: "acct-org" });
    await expect(requestPayerBinding(payer, { subjectUserId: "x", billingAccountId: "acct-org" })).rejects.toMatchObject({ code: "too_many_requests" });
    payer.clock.now += PENDING_BINDING_TTL_DAYS * day;
    // Expired: refused at decide time (nothing to decide), and filtered from the count.
    expect((await decidePayerBinding(payer, grants, { me: me("bob"), id: old.id, approve: true, owners: owners(["bob"]) })).decided).toBe(false);
    expect(await payerFor(payer, "svc")).toBeNull();
    expect((await requestPayerBinding(payer, { subjectUserId: "x", billingAccountId: "acct-org" })).created).toBe(true);
    // The subject's own expired ask is replaced by a fresh one that can be approved.
    const fresh = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    expect(fresh).toMatchObject({ created: true });
    expect(fresh.id).not.toBe(old.id);
    expect((await decidePayerBinding(payer, grants, { me: me("bob"), id: fresh.id, approve: true, owners: owners(["bob"]) })).decided).toBe(true);
    // A live binding does not expire.
    payer.clock.now += 365 * day;
    expect(await payerFor(payer, "svc")).toBe("acct-org");
  });

  it("deny dismisses a pending ask and a later ask starts again", async () => {
    const { grants, payer, me } = fixture();
    const { id } = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    expect((await decidePayerBinding(payer, grants, { me: me("carol"), id, approve: false, owners: owners(["carol"]) })).decided).toBe(true);
    expect(await payerFor(payer, "svc")).toBeNull();
    expect((await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" })).created).toBe(true);
  });
});

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

describe("ownersForBinding (the owner read happens before the decision transaction)", () => {
  it("reads an org's owners once, answers only for that source, and is undefined for a person's account or an unknown binding", async () => {
    const { grants, payer, me } = fixture();
    const { id } = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    const read = vi.fn(async () => ["bob"]);
    const pre = await ownersForBinding(payer, grants, { owners: read }, id);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await pre?.owners(SRC)).toEqual(["bob"]);
    expect(await pre?.owners({ kind: "repo-spec", ref: "https://github.com/cogni-dao/other" })).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    // The decision uses the list read earlier: no second read, and a non-owner is still refused.
    expect((await decidePayerBinding(payer, grants, { me: me("bob"), id, approve: true, owners: pre })).decided).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const personal = await requestPayerBinding(payer, { subjectUserId: "svc2", billingAccountId: "acct-alice" });
    expect(await ownersForBinding(payer, grants, { owners: read }, personal.id)).toBeUndefined();
    expect(await ownersForBinding(payer, grants, { owners: read }, "00000000-0000-4000-8000-00000000ffff")).toBeUndefined();
    expect(await ownersForBinding(payer, grants, undefined, id)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a failed read throws before anything is decided, and a stale list does not let a non-owner through", async () => {
    const { grants, payer, me } = fixture();
    const { id } = await requestPayerBinding(payer, { subjectUserId: "svc", billingAccountId: "acct-org" });
    await expect(ownersForBinding(payer, grants, down, id)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    const pre = await ownersForBinding(payer, grants, owners(["bob"]), id);
    await expect(decidePayerBinding(payer, grants, { me: me("dave"), id, approve: true, owners: pre })).rejects.toMatchObject({ code: "not_allowed" });
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
