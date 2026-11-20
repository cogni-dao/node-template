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
import {
  acceptInvite,
  applyLinkAssertion,
  bindLinkedService,
  changeRole,
  closeLinkByOwner,
  createLinkCode,
  createOrg,
  createPostgresOrgAccountStore,
  createPostgresOrgLinkStore,
  createPostgresPayerBindingStore,
  inviteMember,
  payerFor,
  removeMember,
  setOrgSuspended,
  signLinkAssertion,
  type SqlTag,
} from "@cogni/agent-grants";
import {
  createPostgresReplayStore,
  createServiceAssertionSignerFromSeed,
  ensureServicePrincipal,
  servicePrincipalId,
} from "@cogni/agent-grants/service-auth";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROLLBACK = new Error("rollback");
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const NODE_ID = "node-y";

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
      expect(await store.invitesFor(carol, null, 10)).toEqual([]);
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
      const { code } = await createLinkCode({ orgs, links }, { actorUserId: alice, orgUserId: org.orgUserId, origin: issuer });
      expect(await tx`SELECT 1 FROM org_link_codes WHERE code_hash = ${code}`).toHaveLength(0); // only the hash is stored

      const token = await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: org.orgUserId, code, services: ["node-ai", "git-review"] });
      const linked = await applyLinkAssertion(deps, token);
      expect(linked).toMatchObject({ ok: true, act: "link", orgUserId: org.orgUserId, issuer, bound: 1 });
      expect(await payerFor(payer, aiUser)).toBe(org.billingAccountId);
      expect(await tx`SELECT approved_by FROM payer_bindings WHERE subject_user_id = ${aiUser} AND revoked_at IS NULL`).toEqual([{ approved_by: org.orgUserId }]);
      expect(await tx`SELECT 1 FROM org_link_codes WHERE consumed_at IS NOT NULL AND org_user_id = ${org.orgUserId}`).toHaveLength(1);

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
      const first = await createOrg(orgs, { creatorUserId: alice, name: "first" });
      const secondOrg = await createOrg(orgs, { creatorUserId: alice, name: "second" });
      const issuer = `https://x-${randomUUID().slice(0, 8)}.example`;
      const signer = await createServiceAssertionSignerFromSeed({ issuer, seedHex: SEED });
      const deps = { links, inTransaction: <T>(fn: (l: typeof links) => Promise<T>) => fn(links), selfNodeId: NODE_ID, replay: createPostgresReplayStore(sql), fetchJwks: async () => signer.jwks() };
      const codeOne = (await createLinkCode({ orgs, links }, { actorUserId: alice, orgUserId: first.orgUserId, origin: issuer })).code;
      expect((await applyLinkAssertion(deps, await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: first.orgUserId, code: codeOne, services: ["node-ai"] }))).ok).toBe(true);
      // The owner cannot even make a code for an origin that is linked.
      await expect(createLinkCode({ orgs, links }, { actorUserId: alice, orgUserId: secondOrg.orgUserId, origin: issuer })).rejects.toMatchObject({ code: "issuer_already_linked" });
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
      await orgs.setRole({ orgUserId: org.orgUserId, userId: bob, role: "admin", approvedBy: alice });
      const issuer = `https://x-${randomUUID().slice(0, 8)}.example`;
      const signer = await createServiceAssertionSignerFromSeed({ issuer, seedHex: SEED });
      const deps = { links, inTransaction: <T>(fn: (l: typeof links) => Promise<T>) => fn(links), selfNodeId: NODE_ID, replay: createPostgresReplayStore(sql), fetchJwks: async () => signer.jwks() };
      const aiUser = await ensureServicePrincipal(sql, { issuer, service: "node-ai" });
      expect(aiUser).toBe(await servicePrincipalId({ issuer, service: "node-ai" }));
      const link = async () => {
        const { code } = await createLinkCode({ orgs, links }, { actorUserId: alice, orgUserId: org.orgUserId, origin: issuer });
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

  it("a suspended org is refused with org_suspended at the resolver and links nothing; resuming clears it", async () => {
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
      const { code } = await createLinkCode({ orgs, links }, { actorUserId: alice, orgUserId: org.orgUserId, origin: issuer });
      expect((await applyLinkAssertion(deps, await signLinkAssertion(signer, { audienceNodeId: NODE_ID, act: "link", orgUserId: org.orgUserId, code, services: ["node-ai"] }))).ok).toBe(true);

      expect(await setOrgSuspended(orgs, org.orgUserId, true)).toBe(true);
      await expect(payerFor(payer, aiUser)).rejects.toMatchObject({ code: "org_suspended" });
      await expect(createLinkCode({ orgs, links }, { actorUserId: alice, orgUserId: org.orgUserId, origin: `https://other-${randomUUID().slice(0, 8)}.example` })).rejects.toMatchObject({ code: "org_suspended" });
      expect(await setOrgSuspended(orgs, org.orgUserId, false)).toBe(true);
      expect(await payerFor(payer, aiUser)).toBe(org.billingAccountId);
      // A user that is not an org cannot be suspended.
      expect(await setOrgSuspended(orgs, alice, true)).toBe(false);
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
