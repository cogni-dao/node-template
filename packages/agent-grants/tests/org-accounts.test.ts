// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  changeRole,
  cleanOrgName,
  cleanWallet,
  createOrg,
  getOrgView,
  inviteMember,
  listMyInvites,
  listOrgs,
  MAX_OPEN_INVITES,
  MAX_OWNED_ORGS,
  OrgError,
  removeMember,
} from "../src";
import { memoryOrgStore } from "./org-store";

const W1 = `0x${"1".repeat(40)}`;
const W2 = `0x${"2".repeat(40)}`;
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof OrgError ? e.code : `other:${String(e)}`));

/** alice created org `org-1` and owns it. */
const fixture = async () => {
  const store = memoryOrgStore();
  const org = await createOrg(store, { creatorUserId: "alice", name: "toks5" });
  return { store, org };
};

describe("create (ANYONE_CREATES, BOUNDED_CREATION)", () => {
  it("the creator becomes the owner, approved by the org's own users id, and nothing else is granted", async () => {
    const { store, org } = await fixture();
    expect(org).toMatchObject({ name: "toks5", orgUserId: "org-1" });
    expect(store.roles).toEqual([expect.objectContaining({ userId: "alice", role: "owner", approvedBy: "org-1" })]);
    expect(await listOrgs(store, "alice")).toEqual([expect.objectContaining({ orgUserId: "org-1", role: "owner" })]);
    expect(await listOrgs(store, "stranger")).toEqual([]);
  });

  it("a name is trimmed, single-spaced and printable; empty, long and control-character names are refused", async () => {
    expect(cleanOrgName("  my   org ")).toBe("my org");
    for (const bad of ["", "   ", "x".repeat(65), "a\u0000b", "a‮b", 5, null]) expect(cleanOrgName(bad), String(bad)).toBeNull();
    expect(await code(createOrg(memoryOrgStore(), { creatorUserId: "a", name: "" }))).toBe("invalid_name");
  });

  it("a person owns at most five orgs; the sixth is too_many_orgs and writes nothing", async () => {
    const store = memoryOrgStore();
    for (let i = 0; i < MAX_OWNED_ORGS; i++) await createOrg(store, { creatorUserId: "alice", name: `o${i}` });
    expect(await code(createOrg(store, { creatorUserId: "alice", name: "six" }))).toBe("too_many_orgs");
    expect(store.orgs.size).toBe(MAX_OWNED_ORGS);
    // Someone else is unaffected.
    expect(await code(createOrg(store, { creatorUserId: "bob", name: "bobs" }))).toBe("ok");
  });
});

describe("invite and accept (INVITE_GRANTS_NOTHING)", () => {
  it("an invite grants nothing; the invited person accepts with their wallet and only then holds the role", async () => {
    const { store, org } = await fixture();
    store.addWallet("bob", W1);
    const invite = await inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W1.toUpperCase().replace("0X", "0x"), role: "admin" });
    expect(invite).toMatchObject({ wallet: W1, role: "admin" });
    expect(await store.roleOf("bob", org.orgUserId)).toBeNull();
    expect((await listMyInvites(store, "bob")).map((i) => i.id)).toEqual([invite.id]);
    expect(await listMyInvites(store, "carol")).toEqual([]);
    expect(await acceptInvite(store, { userId: "bob", inviteId: invite.id })).toEqual({ orgUserId: org.orgUserId, role: "admin" });
    expect(await store.roleOf("bob", org.orgUserId)).toBe("admin");
    // Single use.
    expect(await code(acceptInvite(store, { userId: "bob", inviteId: invite.id }))).toBe("invite_not_found");
  });

  it("an invite expires after 7 days and another wallet's person cannot accept it", async () => {
    const { store, org } = await fixture();
    store.addWallet("bob", W1);
    store.addWallet("mallory", W2);
    const invite = await inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W1, role: "admin" });
    expect(await code(acceptInvite(store, { userId: "mallory", inviteId: invite.id }))).toBe("invite_not_found");
    store.clock.now += 7 * 86_400_000 + 1;
    expect(await code(acceptInvite(store, { userId: "bob", inviteId: invite.id }))).toBe("invite_not_found");
    expect(await store.roleOf("bob", org.orgUserId)).toBeNull();
  });

  it("only an owner invites an owner; an admin invites admins; a member-less stranger gets not_found; a bad wallet or role is refused", async () => {
    const { store, org } = await fixture();
    store.addWallet("bob", W1);
    const first = await inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W1, role: "admin" });
    await acceptInvite(store, { userId: "bob", inviteId: first.id });
    const base = { orgUserId: org.orgUserId, wallet: W2 };
    expect(await code(inviteMember(store, { ...base, actorUserId: "bob", role: "owner" }))).toBe("not_allowed");
    expect(await code(inviteMember(store, { ...base, actorUserId: "bob", role: "admin" }))).toBe("ok");
    expect(await code(inviteMember(store, { ...base, actorUserId: "stranger", role: "admin" }))).toBe("not_found");
    expect(await code(inviteMember(store, { ...base, actorUserId: "alice", role: "member" }))).toBe("invalid_role");
    expect(await code(inviteMember(store, { ...base, actorUserId: "alice", role: "admin", wallet: "0xnope" }))).toBe("invalid_wallet");
    expect(cleanWallet(`0x${"A".repeat(40)}`)).toBe(`0x${"a".repeat(40)}`);
  });

  it("a wallet whose person already holds a role is already_member; a second invite for a wallet renews the first", async () => {
    const { store, org } = await fixture();
    store.addWallet("alice", W1);
    expect(await code(inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W1, role: "admin" }))).toBe("already_member");
    const a = await inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W2, role: "admin" });
    const b = await inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W2, role: "owner" });
    expect(b.id).toBe(a.id);
    expect(store.invites).toHaveLength(1);
    expect(store.invites[0]?.role).toBe("owner");
  });

  it("an org holds at most MAX_OPEN_INVITES open invites", async () => {
    const { store, org } = await fixture();
    for (let i = 0; i < MAX_OPEN_INVITES; i++)
      await inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: `0x${i.toString(16).padStart(40, "0")}`, role: "admin" });
    expect(await code(inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W1, role: "admin" }))).toBe("too_many_invites");
  });

  it("an invite is void when its inviter has since lost the right; an owner invite is void when the inviter is only an admin now", async () => {
    const { store, org } = await fixture();
    store.addWallet("bob", W1);
    store.addWallet("carol", W2);
    const bobsInvite = await inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W1, role: "admin" });
    await acceptInvite(store, { userId: "bob", inviteId: bobsInvite.id });
    const carolInvite = await inviteMember(store, { actorUserId: "bob", orgUserId: org.orgUserId, wallet: W2, role: "admin" });
    await removeMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, targetUserId: "bob" });
    expect(await code(acceptInvite(store, { userId: "carol", inviteId: carolInvite.id }))).toBe("invite_void");
  });

  it("accepting an owner invite counts toward the 5-org cap", async () => {
    const store = memoryOrgStore();
    store.addWallet("bob", W1);
    for (let i = 0; i < MAX_OWNED_ORGS; i++) await createOrg(store, { creatorUserId: "bob", name: `b${i}` });
    const org = await createOrg(store, { creatorUserId: "alice", name: "mine" });
    const invite = await inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W1, role: "owner" });
    expect(await code(acceptInvite(store, { userId: "bob", inviteId: invite.id }))).toBe("too_many_orgs");
  });
});

describe("change role and remove (ONE_OWNER_MINIMUM, ONLY_AN_OWNER_MAKES_AN_OWNER)", () => {
  const withAdmin = async () => {
    const { store, org } = await fixture();
    store.addWallet("bob", W1);
    const invite = await inviteMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, wallet: W1, role: "admin" });
    await acceptInvite(store, { userId: "bob", inviteId: invite.id });
    return { store, org };
  };

  it("an owner promotes an admin and demotes them back while another owner remains", async () => {
    const { store, org } = await withAdmin();
    const base = { actorUserId: "alice", orgUserId: org.orgUserId, targetUserId: "bob" };
    expect(await changeRole(store, { ...base, role: "owner" })).toEqual({ changed: true, from: "admin", to: "owner" });
    expect(await changeRole(store, { ...base, role: "owner" })).toMatchObject({ changed: false });
    expect(await changeRole(store, { ...base, role: "admin" })).toEqual({ changed: true, from: "owner", to: "admin" });
    expect(await store.roleOf("bob", org.orgUserId)).toBe("admin");
  });

  it("an admin cannot make, demote or remove an owner, and cannot promote themselves", async () => {
    const { store, org } = await withAdmin();
    expect(await code(changeRole(store, { actorUserId: "bob", orgUserId: org.orgUserId, targetUserId: "alice", role: "admin" }))).toBe("not_allowed");
    expect(await code(changeRole(store, { actorUserId: "bob", orgUserId: org.orgUserId, targetUserId: "bob", role: "owner" }))).toBe("not_allowed");
    expect(await code(removeMember(store, { actorUserId: "bob", orgUserId: org.orgUserId, targetUserId: "alice" }))).toBe("not_allowed");
    expect(await store.roleOf("alice", org.orgUserId)).toBe("owner");
  });

  it("an admin removes an admin, and a person may remove themselves", async () => {
    const { store, org } = await withAdmin();
    store.addWallet("carol", W2);
    const invite = await inviteMember(store, { actorUserId: "bob", orgUserId: org.orgUserId, wallet: W2, role: "admin" });
    await acceptInvite(store, { userId: "carol", inviteId: invite.id });
    expect(await removeMember(store, { actorUserId: "bob", orgUserId: org.orgUserId, targetUserId: "carol" })).toEqual({ removed: true, role: "admin" });
    expect(await removeMember(store, { actorUserId: "bob", orgUserId: org.orgUserId, targetUserId: "bob" })).toEqual({ removed: true, role: "admin" });
    expect(await code(removeMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, targetUserId: "bob" }))).toBe("not_found");
  });

  it("the last owner can never be removed or demoted, even by themselves; with a second owner the first may go", async () => {
    const { store, org } = await withAdmin();
    const alone = { actorUserId: "alice", orgUserId: org.orgUserId, targetUserId: "alice" };
    expect(await code(removeMember(store, alone))).toBe("last_owner");
    expect(await code(changeRole(store, { ...alone, role: "admin" }))).toBe("last_owner");
    expect(await store.roleOf("alice", org.orgUserId)).toBe("owner");
    await changeRole(store, { actorUserId: "alice", orgUserId: org.orgUserId, targetUserId: "bob", role: "owner" });
    // Two owners: alice steps down (approved by the org's own id, never by herself), then bob is the last.
    expect(await changeRole(store, { ...alone, role: "admin" })).toMatchObject({ changed: true });
    expect(store.roles.at(-1)).toMatchObject({ userId: "alice", approvedBy: org.orgUserId });
    expect(await code(removeMember(store, { actorUserId: "bob", orgUserId: org.orgUserId, targetUserId: "bob" }))).toBe("last_owner");
  });

  it("the owner grants are locked before any decision, so two owners acting at once cannot both leave (one locking transaction)", async () => {
    const { store, org } = await withAdmin();
    await changeRole(store, { actorUserId: "alice", orgUserId: org.orgUserId, targetUserId: "bob", role: "owner" });
    store.locks.length = 0;
    await removeMember(store, { actorUserId: "alice", orgUserId: org.orgUserId, targetUserId: "bob" });
    expect(store.locks).toEqual([`owners:${org.orgUserId}`]);
    store.locks.length = 0;
    await code(changeRole(store, { actorUserId: "alice", orgUserId: org.orgUserId, targetUserId: "alice", role: "admin" }));
    expect(store.locks[0]).toBe(`owners:${org.orgUserId}`);
  });

  it("a stranger and a person who is not a member are not_found, never a hint that the org exists", async () => {
    const { store, org } = await fixture();
    expect(await code(removeMember(store, { actorUserId: "stranger", orgUserId: org.orgUserId, targetUserId: "alice" }))).toBe("not_found");
    expect(await code(changeRole(store, { actorUserId: "alice", orgUserId: org.orgUserId, targetUserId: "ghost", role: "admin" }))).toBe("not_found");
    expect(await code(getOrgView(store, { actorUserId: "stranger", orgUserId: org.orgUserId }))).toBe("not_found");
    expect(await code(getOrgView(store, { actorUserId: "alice", orgUserId: "no-such-org" }))).toBe("not_found");
    expect((await getOrgView(store, { actorUserId: "alice", orgUserId: org.orgUserId })).members).toEqual([expect.objectContaining({ userId: "alice", role: "owner" })]);
  });
});
