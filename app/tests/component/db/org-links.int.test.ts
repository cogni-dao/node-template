// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/org-links.int.test`
 * Purpose: The org people and node links of task.0181 through the REAL SQL adapters on Postgres: invite, accept, role change and the owner minimum under the real row locks; the link
 *   code, a signed link (real Ed25519 signer, the package verifier, the durable replay table), one open link per issuer, the bindings, a principal that appears after the link, unlink
 *   from both sides, and the payer resolver's `org_suspended` and `org_link_closed` refusals.
 * Scope: Every test runs in one transaction that is rolled back, so no row leaks to other tests. The key fetch is injected (no network).
 * Invariants: ONE_OWNER_MINIMUM, INVITE_GRANTS_NOTHING, LINK_NEEDS_BOTH_SIDES, ONE_OPEN_LINK_PER_ISSUER, ONE_PAYER_PATH, DURABLE_REPLAY.
 * Side-effects: IO (testcontainers Postgres, rolled back)
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  acceptInvite,
  applyLinkAssertion,
  bindLinkedService,
  changeRole,
  closeLinkByOwner,
  createLinkCode,
  createOrg,
  createPostgresAgentGrantsStore,
  createPostgresOrgAccountStore,
  createPostgresOrgLinkStore,
  createPostgresPayerBindingStore,
  hashLinkToken,
  inviteMember,
  listMembers,
  listOrgs,
  parseLinkCode,
  payerFor,
  previewLinkCode,
  removeMember,
  suspendOrg,
  signLinkAssertion,
  type SqlTag,
} from "@cogni/agent-grants";
import {
  createPostgresReplayStore,
  createServiceAssertionSignerFromSeed,
  ensureServicePrincipal,
  requestServiceAccess,
  servicePrincipalId,
  type VerifiedServiceAssertion,
} from "@cogni/agent-grants/service-auth";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROLLBACK = new Error("rollback");
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const NODE_ID = "node-y";
const SELF = { origin: "https://y.example", nodeId: NODE_ID };

describe("org people and links (real Postgres)", () => {
  let service: Sql;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });
  afterAll(async () => {
    await service?.end({ timeout: 1 });
  });

  const rolledBack = async (fn: (tx: TransactionSql) => Promise<void>) => {
    await service
      .begin(async (tx) => {
        await fn(tx);
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
  };

  const user = async (tx: TransactionSql, name: string): Promise<string> => {
    const id = randomUUID();
    await tx`INSERT INTO users (id, name) VALUES (${id}, ${name})`;
    return id;
  };
  const wallet = () => `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`;
  const bindWallet = async (tx: TransactionSql, userId: string, address: string) => {
    await tx`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${userId}, 'wallet', ${address})`;
  };

  it("invite, accept, change role and remove under the real locks: an invite grants nothing, the last owner stays, an admin cannot touch an owner", async () => {
    await rolledBack(async (tx) => {
      const store = createPostgresOrgAccountStore(tx as unknown as SqlTag);
      const [alice, bob, carol] = [await user(tx, "alice"), await user(tx, "bob"), await user(tx, "carol")] as [string, string, string];
      const [bobWallet, carolWallet] = [wallet(), wallet()];
      await bindWallet(tx, bob, bobWallet);
      await bindWallet(tx, carol, carolWallet);
      const org = await createOrg(store, { creatorUserId: alice, name: "toks5" });

      const invite = await inviteMember(store, { actorUserId: alice, orgUserId: org.orgUserId, wallet: bobWallet.toUpperCase().replace("0X", "0x"), role: "admin" });
      expect(await store.roleOf(bob, org.orgUserId)).toBeNull();
      expect((await store.invitesFor(carol, null, { limit: 10, after: null })).items).toEqual([]);
      await expect(acceptInvite(store, { userId: carol, inviteId: invite.id })).rejects.toMatchObject({ code: "invite_not_found" });
      expect(await acceptInvite(store, { userId: bob, inviteId: invite.id })).toEqual({ orgUserId: org.orgUserId, role: "admin" });
      await expect(acceptInvite(store, { userId: bob, inviteId: invite.id })).rejects.toMatchObject({ code: "invite_not_found" });
      expect(await store.roleOf(bob, org.orgUserId)).toBe("admin");

      // An admin invites an admin, never an owner; cannot touch an owner.
      await expect(inviteMember(store, { actorUserId: bob, orgUserId: org.orgUserId, wallet: carolWallet, role: "owner" })).rejects.toMatchObject({ code: "not_allowed" });
      await expect(changeRole(store, { actorUserId: bob, orgUserId: org.orgUserId, targetUserId: alice, role: "admin" })).rejects.toMatchObject({ code: "not_allowed" });
      await expect(removeMember(store, { actorUserId: bob, orgUserId: org.orgUserId, targetUserId: alice })).rejects.toMatchObject({ code: "not_allowed" });

      // The last owner stays: not removed, not demoted, even by themselves.
      await expect(removeMember(store, { actorUserId: alice, orgUserId: org.orgUserId, targetUserId: alice })).rejects.toMatchObject({ code: "last_owner" });
      await expect(changeRole(store, { actorUserId: alice, orgUserId: org.orgUserId, targetUserId: alice, role: "admin" })).rejects.toMatchObject({ code: "last_owner" });
      // Promote bob; now alice may step down (approved by the org's own id), and bob is the last.
      expect(await changeRole(store, { actorUserId: alice, orgUserId: org.orgUserId, targetUserId: bob, role: "owner" })).toMatchObject({ changed: true, to: "owner" });
      expect(await changeRole(store, { actorUserId: alice, orgUserId: org.orgUserId, targetUserId: alice, role: "admin" })).toMatchObject({ changed: true });
      expect(await tx`SELECT approved_by FROM agent_roles WHERE principal_user_id = ${alice} AND revoked_at IS NULL AND account_id = ${org.billingAccountId}`).toEqual([{ approved_by: org.orgUserId }]);
      await expect(removeMember(store, { actorUserId: bob, orgUserId: org.orgUserId, targetUserId: bob })).rejects.toMatchObject({ code: "last_owner" });
      expect(await removeMember(store, { actorUserId: bob, orgUserId: org.orgUserId, targetUserId: alice })).toEqual({ removed: true, role: "admin" });
      expect(await store.roleOf(alice, org.orgUserId)).toBeNull();
      // One live row per (person, org): the role changes left one row each.
      expect(await tx`SELECT 1 FROM agent_roles WHERE account_id = ${org.billingAccountId} AND revoked_at IS NULL`).toHaveLength(1);
    });
  });

  it("an expired invite cannot be accepted, and an invite for an existing member is refused", async () => {
    await rolledBack(async (tx) => {
      const store = createPostgresOrgAccountStore(tx as unknown as SqlTag);
      const [alice, bob] = [await user(tx, "alice"), await user(tx, "bob")] as [string, string];
      const bobWallet = wallet();
      await bindWallet(tx, bob, bobWallet);
      const org = await createOrg(store, { creatorUserId: alice, name: "org" });
      const invite = await inviteMember(store, { actorUserId: alice, orgUserId: org.orgUserId, wallet: bobWallet, role: "admin" });
      await tx`UPDATE org_invites SET expires_at = now() - interval '1 minute' WHERE id = ${invite.id}::uuid`;
      await expect(acceptInvite(store, { userId: bob, inviteId: invite.id })).rejects.toMatchObject({ code: "invite_not_found" });
      // A fresh invite renews the same open invite (one open invite per org and wallet).
      const again = await inviteMember(store, { actorUserId: alice, orgUserId: org.orgUserId, wallet: bobWallet, role: "admin" });
      expect(again.id).toBe(invite.id);
      await acceptInvite(store, { userId: bob, inviteId: again.id });
      await expect(inviteMember(store, { actorUserId: alice, orgUserId: org.orgUserId, wallet: bobWallet, role: "admin" })).rejects.toMatchObject({ code: "already_member" });
    });
  });

  it("a signed link: the code is burned, one open link per issuer, existing principals bound, a later principal bound on creation, the resolver names the org", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const links = createPostgresOrgLinkStore(sql);
      const payer = createPostgresPayerBindingStore(sql);
      const alice = await user(tx, "alice");
      const org = await createOrg(orgs, { creatorUserId: alice, name: "toks5" });
      const issuer = `https://x-${randomUUID().slice(0, 8)}.example`;
      const signer = await createServiceAssertionSignerFromSeed({ issuer, seedHex: SEED });
      const replay = createPostgresReplayStore(sql);
      const deps = { links, inTransaction: <T>(fn: (l: typeof links) => Promise<T>) => fn(links), selfNodeId: NODE_ID, replay, fetchJwks: async () => signer.jwks() };

      // The ai principal exists (it asked before the link); review does not exist yet.
      const aiUser = await ensureServicePrincipal(sql, { issuer, service: "node-ai" });
      const { code } = await createLinkCode({ orgs, links, self: SELF }, { actorUserId: alice, orgUserId: org.orgUserId, origin: issuer });
      expect(await tx`SELECT 1 FROM org_link_codes WHERE code_hash = ${code}`).toHaveLength(0); // the code itself is never stored
      expect(await tx`SELECT 1 FROM org_link_codes WHERE code_hash = ${await hashLinkToken(parseLinkCode(code)?.secret as string)}`).toHaveLength(1); // only its secret's hash
      // The other node's admin enters only the code: it previews as the org's name and this node's origin, until it is used.
      expect(await previewLinkCode({ links, self: SELF }, code)).toEqual({ orgName: "toks5", origin: SELF.origin });

      const token = await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: org.orgUserId, code, services: ["node-ai", "git-review"] });
      const linked = await applyLinkAssertion(deps, token);
      expect(linked).toMatchObject({ ok: true, act: "link", orgUserId: org.orgUserId, issuer, bound: 1 });
      expect(await payerFor(payer, aiUser)).toBe(org.billingAccountId);
      expect(await tx`SELECT approved_by FROM payer_bindings WHERE subject_user_id = ${aiUser} AND revoked_at IS NULL`).toEqual([{ approved_by: org.orgUserId }]);
      expect(await tx`SELECT 1 FROM org_link_codes WHERE consumed_at IS NOT NULL AND org_user_id = ${org.orgUserId}`).toHaveLength(1);
      expect(await previewLinkCode({ links, self: SELF }, code)).toBeNull(); // a used code previews as nothing

      // Replays and reuse: the same assertion, and a second assertion on the used code, create nothing.
      expect(await applyLinkAssertion(deps, token)).toMatchObject({ ok: false });
      const second = await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: org.orgUserId, code, services: ["node-ai"] });
      expect(await applyLinkAssertion(deps, second)).toMatchObject({ ok: false, code: "link_code_invalid" });
      expect(await tx`SELECT 1 FROM org_links WHERE issuer = ${issuer}`).toHaveLength(1);

      // A principal of a linked service that appears later is bound when it is created.
      const reviewUser = await ensureServicePrincipal(sql, { issuer, service: "git-review" });
      expect(await payerFor(payer, reviewUser)).toBeNull();
      expect(await bindLinkedService(links, { issuer, service: "git-review", subjectUserId: reviewUser })).toBe(true);
      expect(await payerFor(payer, reviewUser)).toBe(org.billingAccountId);
      // A service the link does not name is never bound.
      const other = await ensureServicePrincipal(sql, { issuer, service: "other" });
      expect(await bindLinkedService(links, { issuer, service: "other", subjectUserId: other })).toBe(false);
      expect(await payerFor(payer, other)).toBeNull();
    });
  });

  it("a second link for an open issuer is refused and burns nothing; the database refuses two open links for one issuer", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const links = createPostgresOrgLinkStore(sql);
      const alice = await user(tx, "alice");
      const carol = await user(tx, "carol");
      const first = await createOrg(orgs, { creatorUserId: alice, name: "first" });
      const secondOrg = await createOrg(orgs, { creatorUserId: carol, name: "second" });
      const issuer = `https://x-${randomUUID().slice(0, 8)}.example`;
      const signer = await createServiceAssertionSignerFromSeed({ issuer, seedHex: SEED });
      const deps = { links, inTransaction: <T>(fn: (l: typeof links) => Promise<T>) => fn(links), selfNodeId: NODE_ID, replay: createPostgresReplayStore(sql), fetchJwks: async () => signer.jwks() };
      const codeOne = (await createLinkCode({ orgs, links, self: SELF }, { actorUserId: alice, orgUserId: first.orgUserId, origin: issuer })).code;
      expect((await applyLinkAssertion(deps, await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: first.orgUserId, code: codeOne, services: ["node-ai"] }))).ok).toBe(true);
      // The owner cannot even make a code for an origin that is linked.
      await expect(createLinkCode({ orgs, links, self: SELF }, { actorUserId: carol, orgUserId: secondOrg.orgUserId, origin: issuer })).rejects.toMatchObject({ code: "issuer_already_linked" });
      await tx`SAVEPOINT dup`;
      await expect(tx`INSERT INTO org_links (org_user_id, issuer, services) VALUES (${secondOrg.orgUserId}, ${issuer}, ARRAY['node-ai'])`).rejects.toMatchObject({ constraint_name: "org_links_open_per_issuer" });
      await tx`ROLLBACK TO SAVEPOINT dup`;
    });
  });

  it("unlink from either side closes the link and the bindings: the resolver refuses org_link_closed, and a re-link works", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const links = createPostgresOrgLinkStore(sql);
      const payer = createPostgresPayerBindingStore(sql);
      const [alice, bob] = [await user(tx, "alice"), await user(tx, "bob")] as [string, string];
      const org = await createOrg(orgs, { creatorUserId: alice, name: "toks5" });
      await orgs.setRole({ orgUserId: org.orgUserId, userId: bob, role: "admin", approvedBy: alice, revokedBy: alice });
      const issuer = `https://x-${randomUUID().slice(0, 8)}.example`;
      const signer = await createServiceAssertionSignerFromSeed({ issuer, seedHex: SEED });
      const deps = { links, inTransaction: <T>(fn: (l: typeof links) => Promise<T>) => fn(links), selfNodeId: NODE_ID, replay: createPostgresReplayStore(sql), fetchJwks: async () => signer.jwks() };
      const aiUser = await ensureServicePrincipal(sql, { issuer, service: "node-ai" });
      expect(aiUser).toBe(await servicePrincipalId({ issuer, service: "node-ai" }));
      const link = async () => {
        const { code } = await createLinkCode({ orgs, links, self: SELF }, { actorUserId: alice, orgUserId: org.orgUserId, origin: issuer });
        return applyLinkAssertion(deps, await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: org.orgUserId, code, services: ["node-ai"] }));
      };

      // The owner unlinks (an admin cannot).
      const first = await link();
      expect(first.ok).toBe(true);
      const linkId = first.ok ? first.linkId : "";
      expect(await payerFor(payer, aiUser)).toBe(org.billingAccountId);
      const owned = { orgs, inTransaction: <T>(fn: (l: typeof links) => Promise<T>) => fn(links) };
      await expect(closeLinkByOwner(owned, { actorUserId: bob, orgUserId: org.orgUserId, linkId })).rejects.toMatchObject({ code: "not_allowed" });
      expect(await closeLinkByOwner(owned, { actorUserId: alice, orgUserId: org.orgUserId, linkId })).toMatchObject({ closedBindings: 1 });
      await expect(payerFor(payer, aiUser)).rejects.toMatchObject({ code: "org_link_closed" });

      // Re-link, then the other node unlinks by signing.
      expect((await link()).ok).toBe(true);
      expect(await payerFor(payer, aiUser)).toBe(org.billingAccountId);
      const unlinked = await applyLinkAssertion(deps, await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "unlink", orgUserId: org.orgUserId }));
      expect(unlinked).toMatchObject({ ok: true, act: "unlink", closedBindings: 1 });
      await expect(payerFor(payer, aiUser)).rejects.toMatchObject({ code: "org_link_closed" });
      expect(await applyLinkAssertion(deps, await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "unlink", orgUserId: org.orgUserId }))).toMatchObject({ ok: false, code: "no_open_link" });
      // Closed links and their bindings are kept, never deleted.
      expect(await tx`SELECT 1 FROM org_links WHERE issuer = ${issuer} AND closed_at IS NOT NULL`).toHaveLength(2);
    });
  });

  it("a suspended org is refused with org_suspended at the resolver and links nothing; suspend is final and stores the admin", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const links = createPostgresOrgLinkStore(sql);
      const payer = createPostgresPayerBindingStore(sql);
      const alice = await user(tx, "alice");
      const org = await createOrg(orgs, { creatorUserId: alice, name: "toks5" });
      const issuer = `https://x-${randomUUID().slice(0, 8)}.example`;
      const signer = await createServiceAssertionSignerFromSeed({ issuer, seedHex: SEED });
      const deps = { links, inTransaction: <T>(fn: (l: typeof links) => Promise<T>) => fn(links), selfNodeId: NODE_ID, replay: createPostgresReplayStore(sql), fetchJwks: async () => signer.jwks() };
      const aiUser = await ensureServicePrincipal(sql, { issuer, service: "node-ai" });
      const { code } = await createLinkCode({ orgs, links, self: SELF }, { actorUserId: alice, orgUserId: org.orgUserId, origin: issuer });
      expect((await applyLinkAssertion(deps, await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: org.orgUserId, code, services: ["node-ai"] }))).ok).toBe(true);

      const admin = await user(tx, "admin");
      expect(await suspendOrg(orgs, { orgUserId: org.orgUserId, adminUserId: admin })).toBe(true);
      await expect(payerFor(payer, aiUser)).rejects.toMatchObject({ code: "org_suspended" });
      await expect(createLinkCode({ orgs, links, self: SELF }, { actorUserId: alice, orgUserId: org.orgUserId, origin: `https://other-${randomUUID().slice(0, 8)}.example` })).rejects.toMatchObject({ code: "org_suspended" });
      // Suspend is FINAL: the admin is stored once, a second suspend changes nothing, and nothing lifts it.
      expect(await tx`SELECT suspended_by FROM agent_principals WHERE user_id = ${org.orgUserId}`).toEqual([{ suspended_by: admin }]);
      expect(await suspendOrg(orgs, { orgUserId: org.orgUserId, adminUserId: alice })).toBe(true);
      expect(await tx`SELECT suspended_by FROM agent_principals WHERE user_id = ${org.orgUserId}`).toEqual([{ suspended_by: admin }]);
      await expect(payerFor(payer, aiUser)).rejects.toMatchObject({ code: "org_suspended" });
      // A user that is not an org cannot be suspended.
      expect(await suspendOrg(orgs, { orgUserId: alice, adminUserId: admin })).toBe(false);
    });
  });

  it("a link that closed while a bind was in flight: a bind after the close writes nothing, and a live binding under a closed link never bills", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const links = createPostgresOrgLinkStore(sql);
      const payer = createPostgresPayerBindingStore(sql);
      const alice = await user(tx, "alice");
      const org = await createOrg(orgs, { creatorUserId: alice, name: "toks5" });
      const issuer = `https://x-${randomUUID().slice(0, 8)}.example`;
      const aiUser = await ensureServicePrincipal(sql, { issuer, service: "node-ai" });
      const linkId = (await links.insertLink({ orgUserId: org.orgUserId, issuer, services: ["node-ai"], createdBy: alice })) as string;
      await links.closeLink({ linkId, closedBy: alice });
      expect(await links.bindPrincipals({ linkId, orgUserId: org.orgUserId, principalIds: [aiUser] })).toBe(0);
      expect(await tx`SELECT 1 FROM payer_bindings WHERE subject_user_id = ${aiUser}`).toHaveLength(0);
      // A binding that raced the close and landed live under the closed link is refused, not billed.
      await tx`INSERT INTO payer_bindings (subject_user_id, billing_account_id, approved_by, approved_at, link_id) VALUES (${aiUser}, ${org.billingAccountId}, ${org.orgUserId}, now(), ${linkId}::uuid)`;
      await expect(payerFor(payer, aiUser)).rejects.toMatchObject({ code: "org_link_closed" });
    });
  });

  it("a binding no link wrote (the retired ask flow) bills nothing", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const payer = createPostgresPayerBindingStore(sql);
      const [alice, svc] = [await user(tx, "alice"), await user(tx, "svc")] as [string, string];
      const org = await createOrg(orgs, { creatorUserId: alice, name: "toks5" });
      await tx`INSERT INTO payer_bindings (subject_user_id, billing_account_id, approved_by, approved_at) VALUES (${svc}, ${org.billingAccountId}, ${alice}, now())`;
      expect(await payerFor(payer, svc)).toBeNull();
    });
  });

  it("a role that has ended (expires_at) is no role: roleOf, the org lists and the owner source all agree with authorizeAccount", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const [alice, bob] = [await user(tx, "alice"), await user(tx, "bob")] as [string, string];
      const org = await createOrg(orgs, { creatorUserId: alice, name: "toks5" });
      await orgs.setRole({ orgUserId: org.orgUserId, userId: bob, role: "admin", approvedBy: alice, revokedBy: alice });
      expect(await orgs.roleOf(bob, org.orgUserId)).toBe("admin");
      await tx`UPDATE agent_roles SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE principal_user_id = ${bob} AND account_id = ${org.billingAccountId}`;
      expect(await orgs.roleOf(bob, org.orgUserId)).toBeNull();
      expect((await listOrgs(orgs, bob)).items).toEqual([]);
      expect((await listMembers(orgs, { actorUserId: alice, orgUserId: org.orgUserId })).items.map((m) => m.userId)).toEqual([alice]);
      await expect(listMembers(orgs, { actorUserId: bob, orgUserId: org.orgUserId })).rejects.toMatchObject({ code: "not_found" });
    });
  });

  it("lists page with a cursor and never cut silently: 7 members read two at a time reach every row once", async () => {
    await rolledBack(async (tx) => {
      const orgs = createPostgresOrgAccountStore(tx as unknown as SqlTag);
      const alice = await user(tx, "alice");
      const org = await createOrg(orgs, { creatorUserId: alice, name: "big" });
      const ids = [alice];
      for (let i = 0; i < 6; i++) {
        const id = await user(tx, `m${i}`);
        ids.push(id);
        await orgs.setRole({ orgUserId: org.orgUserId, userId: id, role: "admin", approvedBy: alice, revokedBy: alice });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof listMembers>> = await listMembers(orgs, { actorUserId: alice, orgUserId: org.orgUserId, limit: 2, cursor });
        seen.push(...page.items.map((m) => m.userId));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(4);
      expect(seen.sort()).toEqual([...ids].sort());
      // Orgs of one person page the same way. In release 1 a person holds an owner and an admin role in one org each, so two orgs; a page of one reaches both.
      const bob = await user(tx, "bob");
      const bobs = await createOrg(orgs, { creatorUserId: bob, name: "bobs" });
      await orgs.setRole({ orgUserId: bobs.orgUserId, userId: alice, role: "admin", approvedBy: bob, revokedBy: bob });
      const orgsSeen: string[] = [];
      let orgCursor: string | null = null;
      let orgPages = 0;
      do {
        const page: Awaited<ReturnType<typeof listOrgs>> = await listOrgs(orgs, alice, { limit: 1, cursor: orgCursor });
        orgsSeen.push(...page.items.map((o) => o.orgUserId));
        orgCursor = page.nextCursor;
        orgPages++;
      } while (orgCursor);
      expect(orgPages).toBe(2);
      expect(new Set(orgsSeen)).toEqual(new Set([org.orgUserId, bobs.orgUserId]));
    });
  });

  it("every act names its actor on its own row: invite, accept, link code, link, and an unlink by the owner and by the other node's signature", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const links = createPostgresOrgLinkStore(sql);
      const [alice, bob] = [await user(tx, "alice"), await user(tx, "bob")] as [string, string];
      const bobWallet = wallet();
      await bindWallet(tx, bob, bobWallet);
      const org = await createOrg(orgs, { creatorUserId: alice, name: "actors" });
      const invite = await inviteMember(orgs, { actorUserId: alice, orgUserId: org.orgUserId, wallet: bobWallet, role: "admin" });
      expect(await tx`SELECT invited_by, accepted_by FROM org_invites WHERE id = ${invite.id}::uuid`).toEqual([{ invited_by: alice, accepted_by: null }]);
      await acceptInvite(orgs, { userId: bob, inviteId: invite.id });
      expect(await tx`SELECT invited_by, accepted_by FROM org_invites WHERE id = ${invite.id}::uuid`).toEqual([{ invited_by: alice, accepted_by: bob }]);
      // The grant row names the person who approved it (the inviter), distinct from the principal.
      expect(await tx`SELECT approved_by FROM agent_roles WHERE principal_user_id = ${bob} AND account_id = ${org.billingAccountId} AND revoked_at IS NULL`).toEqual([{ approved_by: alice }]);

      const issuer = `https://x-${randomUUID().slice(0, 8)}.example`;
      const signer = await createServiceAssertionSignerFromSeed({ issuer, seedHex: SEED });
      const deps = { links, inTransaction: <T>(fn: (l: typeof links) => Promise<T>) => fn(links), selfNodeId: NODE_ID, replay: createPostgresReplayStore(sql), fetchJwks: async () => signer.jwks() };
      const link = async () => {
        const { code } = await createLinkCode({ orgs, links, self: SELF }, { actorUserId: alice, orgUserId: org.orgUserId, origin: issuer });
        const result = await applyLinkAssertion(deps, await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: org.orgUserId, code, services: ["node-ai"] }));
        return result.ok ? result.linkId : "";
      };
      expect(await tx`SELECT created_by FROM org_link_codes WHERE org_user_id = ${org.orgUserId}`).toEqual([]);
      const first = await link();
      expect(await tx`SELECT created_by FROM org_link_codes WHERE org_user_id = ${org.orgUserId}`).toEqual([{ created_by: alice }]);
      expect(await tx`SELECT created_by, closed_by FROM org_links WHERE id = ${first}::uuid`).toEqual([{ created_by: alice, closed_by: null }]);
      // The owner unlinks: the owner is stored. A second link, closed by the other node's signature, stores the org's own users id (no person did it).
      await closeLinkByOwner({ orgs, inTransaction: <T>(fn: (l: typeof links) => Promise<T>) => fn(links) }, { actorUserId: alice, orgUserId: org.orgUserId, linkId: first });
      expect(await tx`SELECT closed_by FROM org_links WHERE id = ${first}::uuid`).toEqual([{ closed_by: alice }]);
      const second = await link();
      await applyLinkAssertion(deps, await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "unlink", orgUserId: org.orgUserId }));
      expect(await tx`SELECT closed_by FROM org_links WHERE id = ${second}::uuid`).toEqual([{ closed_by: org.orgUserId }]);
    });
  });

  it("the durable replay table refuses a replay after the first use and takes over an expired row", async () => {
    await rolledBack(async (tx) => {
      const replay = createPostgresReplayStore(tx as unknown as SqlTag);
      const jti = `iss#${randomUUID()}`;
      expect(await replay.seen(jti, new Date(Date.now() + 60_000))).toBe(false);
      expect(await replay.seen(jti, new Date(Date.now() + 60_000))).toBe(true);
      await tx`UPDATE service_assertion_jtis SET expires_at = now() - interval '1 second' WHERE jti = ${jti}`;
      expect(await replay.seen(jti, new Date(Date.now() + 60_000))).toBe(false);
    });
  });
});

describe("two real connections (committed data, row locks)", () => {
  let service: Sql;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 4 });
  });
  afterAll(async () => {
    await service?.end({ timeout: 1 });
  });

  /** A committed org with two owners; the rows are removed again whatever the test says. */
  async function withOrg(fn: (ctx: { org: { orgUserId: string; billingAccountId: string }; alice: string; bob: string }) => Promise<void>): Promise<void> {
    const [alice, bob] = [randomUUID(), randomUUID()];
    let org: { orgUserId: string; billingAccountId: string } | undefined;
    try {
      await service`INSERT INTO users (id, name) VALUES (${alice}, 'alice'), (${bob}, 'bob')`;
      org = await createOrg(createPostgresOrgAccountStore(service as unknown as SqlTag), { creatorUserId: alice, name: "race" });
      await createPostgresOrgAccountStore(service as unknown as SqlTag).setRole({ orgUserId: org.orgUserId, userId: bob, role: "owner", approvedBy: alice, revokedBy: alice });
      await fn({ org, alice, bob });
    } finally {
      if (org) {
        await service`DELETE FROM payer_bindings WHERE billing_account_id = ${org.billingAccountId}`.catch(() => undefined);
        await service`DELETE FROM org_links WHERE org_user_id = ${org.orgUserId}`.catch(() => undefined);
        await service`DELETE FROM org_link_codes WHERE org_user_id = ${org.orgUserId}`.catch(() => undefined);
        await service`DELETE FROM org_invites WHERE org_user_id = ${org.orgUserId}`.catch(() => undefined);
        await service`DELETE FROM agent_roles WHERE account_id = ${org.billingAccountId}`.catch(() => undefined);
        await service`DELETE FROM virtual_keys WHERE billing_account_id = ${org.billingAccountId}`.catch(() => undefined);
        await service`DELETE FROM billing_accounts WHERE id = ${org.billingAccountId}`.catch(() => undefined);
        await service`DELETE FROM agent_principals WHERE user_id = ${org.orgUserId}`.catch(() => undefined);
        await service`DELETE FROM users WHERE id IN (${org.orgUserId}, ${alice}, ${bob})`.catch(() => undefined);
      }
    }
  }

  /** Runs `first` in a transaction that stays open until `release()`, starts `second` in another connection while it is open, and returns both outcomes. */
  async function overlapped<A, B>(first: (tx: TransactionSql) => Promise<A>, second: (tx: TransactionSql) => Promise<B>): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstDone: () => void = () => undefined;
    const firstReady = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    const a = service.begin(async (tx) => {
      const result = await first(tx);
      firstDone();
      await gate; // commit only after the second transaction is already waiting on this one's locks
      return result;
    });
    await firstReady;
    const b = service.begin((tx) => second(tx));
    // Give the second transaction time to reach (and block on) the first one's locks, then let the first commit.
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    return Promise.allSettled([a, b]) as Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]>;
  }

  it("two owners leave at once: exactly one gets last_owner and one owner is left (the owner grants are locked in the same transaction)", async () => {
    await withOrg(async ({ org, alice, bob }) => {
      const leave = (userId: string) => (tx: TransactionSql) => removeMember(createPostgresOrgAccountStore(tx as unknown as SqlTag), { actorUserId: userId, orgUserId: org.orgUserId, targetUserId: userId });
      const [one, two] = await overlapped(leave(alice), leave(bob));
      expect(one.status).toBe("fulfilled");
      expect(two.status).toBe("rejected");
      expect((two as PromiseRejectedResult).reason).toMatchObject({ code: "last_owner" });
      const owners = await service`SELECT principal_user_id FROM agent_roles WHERE account_id = ${org.billingAccountId} AND scope = 'org:owner' AND revoked_at IS NULL`;
      expect(owners).toEqual([{ principal_user_id: bob }]);
    });
  });

  it("two owners demote each other at once: exactly one is refused as last_owner", async () => {
    await withOrg(async ({ org, alice, bob }) => {
      const demote = (actor: string, target: string) => (tx: TransactionSql) =>
        changeRole(createPostgresOrgAccountStore(tx as unknown as SqlTag), { actorUserId: actor, orgUserId: org.orgUserId, targetUserId: target, role: "admin" });
      const [one, two] = await overlapped(demote(alice, bob), demote(bob, alice));
      expect([one.status, two.status].sort()).toEqual(["fulfilled", "rejected"]);
      const loser = [one, two].find((r) => r.status === "rejected") as PromiseRejectedResult;
      // The second sees the first's committed demotion: its actor is no longer an owner (not_allowed) or it would demote the last one (last_owner). Never both demoted.
      expect(["last_owner", "not_allowed"]).toContain((loser.reason as { code: string }).code);
      expect(await service`SELECT 1 FROM agent_roles WHERE account_id = ${org.billingAccountId} AND scope = 'org:owner' AND revoked_at IS NULL`).toHaveLength(1);
    });
  });

  it("two accepts of one person's role race: the live-row index refuses the second as 409 already_member, not an outage", async () => {
    await withOrg(async ({ org, alice }) => {
      const carol = randomUUID();
      await service`INSERT INTO users (id, name) VALUES (${carol}, 'carol')`;
      try {
        const set = (tx: TransactionSql) => createPostgresOrgAccountStore(tx as unknown as SqlTag).setRole({ orgUserId: org.orgUserId, userId: carol, role: "admin", approvedBy: alice, revokedBy: alice });
        const [one, two] = await overlapped(set, set);
        expect(one.status).toBe("fulfilled");
        expect(two.status).toBe("rejected");
        expect((two as PromiseRejectedResult).reason).toMatchObject({ name: "OrgError", code: "already_member" });
        expect(await service`SELECT 1 FROM agent_roles WHERE account_id = ${org.billingAccountId} AND principal_user_id = ${carol} AND revoked_at IS NULL`).toHaveLength(1);
      } finally {
        await service`DELETE FROM agent_roles WHERE principal_user_id = ${carol}`.catch(() => undefined);
        await service`DELETE FROM users WHERE id = ${carol}`.catch(() => undefined);
      }
    });
  });

  /** Runs `first` until it calls `hold()`, then starts `second` while `first`'s transaction is still open, lets `first` commit, and returns both outcomes. */
  async function holding<A, B>(first: (hold: () => Promise<void>) => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((resolveReady) => {
      ready = resolveReady;
    });
    const a = first(async () => {
      ready();
      await gate;
    });
    await Promise.race([isReady, a.then(() => undefined, () => undefined)]);
    const b = second();
    // Give the second transaction time to reach (and block on) the first one's locks, then let the first commit.
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    release();
    return Promise.all([a, b]);
  }

  /** A trusted issuer and a node-ai principal that is about to enroll while its issuer links (a statically trusted home is the case the review named). */
  async function linkRace(order: "link first" | "enrollment first"): Promise<void> {
    await withOrg(async ({ org, alice }) => {
      const sqlTag = service as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sqlTag);
      const links = createPostgresOrgLinkStore(sqlTag);
      const issuer = `https://race-${randomUUID().slice(0, 8)}.example`;
      const principal = await servicePrincipalId({ issuer, service: "node-ai" });
      const signer = await createServiceAssertionSignerFromSeed({ issuer, seedHex: SEED });
      const { code } = await createLinkCode({ orgs, links, self: SELF }, { actorUserId: alice, orgUserId: org.orgUserId, origin: issuer });
      const assertion: VerifiedServiceAssertion = { ok: true, issuer, service: "node-ai", clientId: `${issuer}#node-ai`, scope: "knowledge:read", jti: randomUUID(), claims: {} };
      const token = await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: org.orgUserId, code, services: ["node-ai"] });
      const linkDeps = (begin: (fn: (tx: TransactionSql) => Promise<unknown>) => Promise<unknown>) => ({
        links,
        inTransaction: ((fn: (l: ReturnType<typeof createPostgresOrgLinkStore>) => Promise<unknown>) => begin((tx) => fn(createPostgresOrgLinkStore(tx as unknown as SqlTag)))) as never,
        selfNodeId: NODE_ID,
        replay: createPostgresReplayStore(sqlTag),
        fetchJwks: async () => signer.jwks(),
      });
      const link = (hold?: () => Promise<void>) =>
        applyLinkAssertion(
          linkDeps((fn) =>
            service.begin(async (tx) => {
              const result = await fn(tx);
              if (hold) await hold();
              return result;
            })
          ),
          token
        );
      const enroll = (hold?: () => Promise<void>) =>
        service.begin(async (tx) => {
          const t = tx as unknown as SqlTag;
          const result = await requestServiceAccess({
            tx: t,
            store: createPostgresAgentGrantsStore(t),
            assertion,
            scope: "knowledge:read",
            declaredScopes: ["knowledge:read"],
            askableScopes: ["knowledge:read"],
            scopeKinds: { "knowledge:read": "node" },
            // The same two hooks the node wires: the issuer's lock first, then the bind of a principal of a linked service.
            beforePrincipal: () => createPostgresOrgLinkStore(t).lockIssuer(issuer),
            onPrincipal: async (userId) => void (await bindLinkedService(createPostgresOrgLinkStore(t), { issuer, service: "node-ai", subjectUserId: userId })),
          });
          if (hold) await hold();
          return result;
        });
      try {
        if (order === "link first") {
          const [linked] = await holding((hold) => link(hold), () => enroll());
          expect(linked).toMatchObject({ ok: true, act: "link" });
        } else {
          const [, linked] = await holding((hold) => enroll(hold), () => link());
          expect(linked).toMatchObject({ ok: true, act: "link" });
        }
        // Whichever committed first, the principal exists AND is bound: the payer is the org's account.
        expect(await payerFor(createPostgresPayerBindingStore(sqlTag), principal)).toBe(org.billingAccountId);
        expect(await service`SELECT 1 FROM payer_bindings WHERE subject_user_id = ${principal} AND revoked_at IS NULL`).toHaveLength(1);
      } finally {
        await service`DELETE FROM payer_bindings WHERE subject_user_id = ${principal}`.catch(() => undefined);
        await service`DELETE FROM agent_roles WHERE principal_user_id = ${principal}`.catch(() => undefined);
        await service`DELETE FROM agent_principals WHERE user_id = ${principal}`.catch(() => undefined);
        await service`DELETE FROM users WHERE id = ${principal}`.catch(() => undefined);
      }
    });
  }

  it("link vs enrollment of the same issuer, the link commits first: the principal that enrolls during the link is bound (the payer is the org)", async () => {
    await linkRace("link first");
  });

  it("link vs enrollment of the same issuer, the enrollment commits first: the link binds the principal that already exists (the payer is the org)", async () => {
    await linkRace("enrollment first");
  });

  it("the final invite slot: two invites for different wallets race at 49 open, exactly one succeeds and the org never holds more than 50", async () => {
    await withOrg(async ({ org, alice }) => {
      for (let i = 0; i < 49; i++)
        await service`INSERT INTO org_invites (org_user_id, wallet, scope, invited_by, expires_at) VALUES (${org.orgUserId}, ${`0x${i.toString(16).padStart(40, "0")}`}, 'org:admin', ${alice}, now() + interval '7 days')`;
      const invite = (wallet: string) => (tx: TransactionSql) => inviteMember(createPostgresOrgAccountStore(tx as unknown as SqlTag), { actorUserId: alice, orgUserId: org.orgUserId, wallet, role: "admin" });
      const wallets = [`0x${"a".repeat(40)}`, `0x${"b".repeat(40)}`];
      const [one, two] = await overlapped(invite(wallets[0] as string), invite(wallets[1] as string));
      expect([one.status, two.status].sort()).toEqual(["fulfilled", "rejected"]);
      const loser = [one, two].find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ code: "too_many_invites" });
      expect(await service`SELECT 1 FROM org_invites WHERE org_user_id = ${org.orgUserId} AND accepted_at IS NULL AND revoked_at IS NULL`).toHaveLength(50);
    });
  });

  it("the final link-code slot: two codes race at 9 open, exactly one succeeds and the org never holds more than 10", async () => {
    await withOrg(async ({ org, alice }) => {
      for (let i = 0; i < 9; i++)
        await service`INSERT INTO org_link_codes (org_user_id, origin, code_hash, created_by, expires_at) VALUES (${org.orgUserId}, ${`https://n${i}.example`}, ${`hash-${randomUUID()}`}, ${alice}, now() + interval '15 minutes')`;
      const code = (origin: string) => (tx: TransactionSql) =>
        createLinkCode({ orgs: createPostgresOrgAccountStore(tx as unknown as SqlTag), links: createPostgresOrgLinkStore(tx as unknown as SqlTag), self: SELF }, { actorUserId: alice, orgUserId: org.orgUserId, origin });
      const [one, two] = await overlapped(code("https://a.example"), code("https://b.example"));
      expect([one.status, two.status].sort()).toEqual(["fulfilled", "rejected"]);
      const loser = [one, two].find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ code: "too_many_codes" });
      expect(await service`SELECT 1 FROM org_link_codes WHERE org_user_id = ${org.orgUserId} AND consumed_at IS NULL`).toHaveLength(10);
    });
  });
});

describe("the forward migration 0051 (real Postgres, rolled back)", () => {
  let service: Sql;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });
  afterAll(async () => {
    await service?.end({ timeout: 1 });
  });

  /** The hand-written repair part of 0051, one statement per chunk. */
  const repairStatements = (): string[] => {
    const text = readFileSync(resolve(__dirname, "../../../src/adapters/server/db/migrations/0051_org_roles_forward.sql"), "utf8");
    return text
      .slice(text.indexOf("-- Hand-written below"))
      .split("--> statement-breakpoint")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
  };

  it("repairs the database the rejected first 0050 left: keeps the oldest live row per (principal, scope) with no human revoker, restores the old index, adds the new one, and is safe to run again", async () => {
    await service
      .begin(async (tx) => {
        const user = async (name: string) => {
          const id = randomUUID();
          await tx`INSERT INTO users (id, name) VALUES (${id}, ${name})`;
          return id;
        };
        const sqlTag = tx as unknown as SqlTag;
        const orgs = createPostgresOrgAccountStore(sqlTag);
        const [p, q, bob, carol] = [await user("p"), await user("q"), await user("bob"), await user("carol")] as [string, string, string, string];
        const [a1, a2, a3] = [await createOrg(orgs, { creatorUserId: bob, name: "one" }), await createOrg(orgs, { creatorUserId: carol, name: "two" }), await createOrg(orgs, { creatorUserId: q, name: "three" })];
        // The state the rejected 0050 left: the old index replaced by the account-aware one under the OLD NAME, and the new one absent.
        await tx.unsafe("DROP INDEX agent_roles_live_unique");
        await tx.unsafe("DROP INDEX IF EXISTS agent_roles_live_account_unique");
        await tx.unsafe(`CREATE UNIQUE INDEX agent_roles_live_unique ON agent_roles (principal_user_id, scope, coalesce(account_id, '')) WHERE revoked_at IS NULL`);
        const give = (principal: string, accountId: string, ago: string) =>
          tx.unsafe(
            `INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, created_at, resource, account_id)
             VALUES ('${principal}', 'org:owner', '${bob}', now(), now() - interval '${ago}', 'account', '${accountId}')`
          );
        await give(p, a1.billingAccountId, "2 days"); // the oldest: kept
        await give(p, a2.billingAccountId, "1 day"); // a duplicate the bad state allowed: ended
        await give(p, a3.billingAccountId, "1 hour"); // another duplicate: ended
        const before = await tx`SELECT 1 FROM agent_roles WHERE principal_user_id = ${p} AND scope = 'org:owner' AND revoked_at IS NULL`;
        expect(before).toHaveLength(3);

        for (const statement of repairStatements()) await tx.unsafe(statement);
        for (const statement of repairStatements()) await tx.unsafe(statement); // safe to run again

        const live = await tx`SELECT account_id FROM agent_roles WHERE principal_user_id = ${p} AND scope = 'org:owner' AND revoked_at IS NULL`;
        expect(live).toEqual([{ account_id: a1.billingAccountId }]);
        // The ended rows name no person: the migration, not an actor, ended them.
        const ended = await tx`SELECT account_id, revoked_by FROM agent_roles WHERE principal_user_id = ${p} AND scope = 'org:owner' AND revoked_at IS NOT NULL ORDER BY account_id`;
        expect(ended).toHaveLength(2);
        expect(ended.every((row) => row.revoked_by === null)).toBe(true);
        // A principal with one live row, and the org owners of other orgs, are untouched.
        expect(await tx`SELECT 1 FROM agent_roles WHERE principal_user_id = ${q} AND scope = 'org:owner' AND revoked_at IS NULL`).toHaveLength(1);
        const defs = await tx`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'agent_roles' AND indexname IN ('agent_roles_live_unique', 'agent_roles_live_account_unique') ORDER BY indexname`;
        expect(defs.map((d) => d.indexname)).toEqual(["agent_roles_live_account_unique", "agent_roles_live_unique"]);
        expect(String(defs[1]?.indexdef)).not.toContain("COALESCE");
        // The previous release's writer works again: its ON CONFLICT infers the restored index and finds the live row.
        const old = await tx`INSERT INTO agent_roles (principal_user_id, scope, approved_by) VALUES (${p}, 'org:owner', ${bob}) ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING RETURNING id`;
        expect(old).toHaveLength(0);
        throw new Error("rollback");
      })
      .catch((error: unknown) => {
        if ((error as Error).message !== "rollback") throw error;
      });
  });
});

