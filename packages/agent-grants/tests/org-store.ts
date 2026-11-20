// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { OpenInvite, OrgAccountStore, OrgLinkStore, OrgMember, OrgMembership, OrgRecord, OpenLink, OrgRole } from "../src";

interface Role {
  userId: string;
  orgUserId: string;
  role: OrgRole;
  approvedBy: string;
  at: number;
  live: boolean;
}
interface Invite extends OpenInvite {
  wallet: string;
  open: boolean;
  expiresMs: number;
}

/**
 * In-memory org store with the semantics of the Postgres adapter: a live role is one row per (person, org), `lockOwners` returns the live owners, a setRole ends the old row, an invite
 * is single use and expires on the clock. `clock.now` is ms.
 */
export function memoryOrgStore(init?: { wallets?: Record<string, string[]> }) {
  const clock = { now: 1_000_000 };
  const orgs = new Map<string, OrgRecord>();
  const roles: Role[] = [];
  const invites: Invite[] = [];
  const wallets = init?.wallets ?? {};
  let n = 0;
  const live = (orgUserId: string) => roles.filter((r) => r.orgUserId === orgUserId && r.live);
  const roleOf = (userId: string, orgUserId: string): OrgRole | null => {
    const mine = live(orgUserId).filter((r) => r.userId === userId);
    return mine.some((r) => r.role === "owner") ? "owner" : mine.length > 0 ? "admin" : null;
  };
  const owned = (userId: string) => [...orgs.keys()].filter((o) => live(o).some((r) => r.userId === userId && r.role === "owner")).length;
  const store: OrgAccountStore & { orgs: typeof orgs; roles: Role[]; invites: Invite[]; locks: string[]; clock: typeof clock; addWallet(userId: string, wallet: string): void } = {
    orgs,
    roles,
    invites,
    locks: [],
    clock,
    addWallet: (userId, wallet) => {
      wallets[userId] = [...(wallets[userId] ?? []), wallet];
    },
    async createOrg({ creatorUserId, name, maxOwned }) {
      if (owned(creatorUserId) >= maxOwned) return "too_many_orgs";
      const orgUserId = `org-${++n}`;
      orgs.set(orgUserId, { orgUserId, name, billingAccountId: `acct-${orgUserId}`, suspendedAt: null });
      roles.push({ userId: creatorUserId, orgUserId, role: "owner", approvedBy: orgUserId, at: clock.now, live: true });
      return { orgUserId, billingAccountId: `acct-${orgUserId}` };
    },
    async getOrg(orgUserId) {
      return orgs.get(orgUserId) ?? null;
    },
    async listOrgsOf(userId, limit): Promise<OrgMembership[]> {
      return [...orgs.values()].flatMap((o) => {
        const role = roleOf(userId, o.orgUserId);
        return role ? [{ ...o, role }] : [];
      }).slice(0, limit);
    },
    roleOf: async (userId, orgUserId) => roleOf(userId, orgUserId),
    async members(orgUserId, limit): Promise<OrgMember[]> {
      return live(orgUserId).slice(0, limit).map((r) => ({ userId: r.userId, name: r.userId, role: r.role, since: String(r.at) }));
    },
    async lockOwners(orgUserId) {
      store.locks.push(`owners:${orgUserId}`);
      return live(orgUserId).filter((r) => r.role === "owner").map((r) => r.userId);
    },
    async lockAndCountOwned(userId) {
      store.locks.push(`person:${userId}`);
      return owned(userId);
    },
    async setRole({ orgUserId, userId, role, approvedBy }) {
      if (approvedBy === userId) throw new Error("agent_roles_no_self_approval");
      for (const r of roles) if (r.orgUserId === orgUserId && r.userId === userId) r.live = false;
      roles.push({ userId, orgUserId, role, approvedBy, at: clock.now, live: true });
    },
    async removeRole({ orgUserId, userId }) {
      const mine = live(orgUserId).filter((r) => r.userId === userId);
      for (const r of mine) r.live = false;
      return mine.length > 0;
    },
    async usersOfWallet(wallet) {
      return Object.entries(wallets).flatMap(([userId, list]) => (list.includes(wallet) ? [userId] : []));
    },
    async upsertInvite({ orgUserId, wallet, role, invitedBy, ttlDays, maxOpen }) {
      const open = invites.filter((i) => i.orgUserId === orgUserId && i.open && i.expiresMs > clock.now);
      const same = invites.find((i) => i.orgUserId === orgUserId && i.wallet === wallet && i.open);
      if (!same && open.length >= maxOpen) return "too_many_invites";
      const expiresMs = clock.now + ttlDays * 86_400_000;
      if (same) {
        Object.assign(same, { role, invitedBy, expiresMs, expiresAt: String(expiresMs) });
        return { id: same.id, expiresAt: same.expiresAt };
      }
      const invite: Invite = { id: `inv-${++n}`, orgUserId, orgName: orgs.get(orgUserId)?.name ?? "", role, invitedBy, wallet, open: true, expiresMs, expiresAt: String(expiresMs) };
      invites.push(invite);
      return { id: invite.id, expiresAt: invite.expiresAt };
    },
    async invitesFor(userId, inviteId, limit) {
      const mine = wallets[userId] ?? [];
      return invites.filter((i) => i.open && i.expiresMs > clock.now && mine.includes(i.wallet) && (inviteId === null || i.id === inviteId)).slice(0, limit);
    },
    async consumeInvite({ inviteId, userId }) {
      const invite = invites.find((i) => i.id === inviteId);
      if (!invite || !invite.open || invite.expiresMs <= clock.now || !(wallets[userId] ?? []).includes(invite.wallet)) return false;
      invite.open = false;
      return true;
    },
    async setSuspended(orgUserId, suspended) {
      const org = orgs.get(orgUserId);
      if (!org) return false;
      orgs.set(orgUserId, { ...org, suspendedAt: suspended ? "now" : null });
      return true;
    },
  };
  return store;
}

interface Code {
  orgUserId: string;
  origin: string;
  hash: string;
  consumed: boolean;
  expiresMs: number;
}
interface Binding {
  subject: string;
  accountOrg: string;
  linkId: string;
  open: boolean;
}

/**
 * In-memory link store with the Postgres semantics: one open link per issuer, a code is single use and expires, bindings are written for EXISTING principals only and end with the link.
 * `principals` holds the user ids that exist (a service principal that has asked).
 */
export function memoryLinkStore(orgs: { suspended?: Record<string, boolean> } = {}) {
  const clock = { now: 1_000_000 };
  const codes: Code[] = [];
  const links: Array<OpenLink & { open: boolean; closedBy: string | null }> = [];
  const bindings: Binding[] = [];
  const principals = new Set<string>();
  let n = 0;
  const store: OrgLinkStore & { codes: Code[]; links: typeof links; bindings: Binding[]; principals: Set<string>; clock: typeof clock; suspended: Record<string, boolean> } = {
    codes,
    links,
    bindings,
    principals,
    clock,
    suspended: orgs.suspended ?? {},
    async openLinkOfIssuer(issuer) {
      return links.find((l) => l.issuer === issuer && l.open) ?? null;
    },
    async openLinksOfOrg(orgUserId) {
      return links.filter((l) => l.orgUserId === orgUserId && l.open);
    },
    async createCode({ orgUserId, origin, codeHash, ttlMinutes, maxOpen }) {
      if (codes.filter((c) => c.orgUserId === orgUserId && !c.consumed && c.expiresMs > clock.now).length >= maxOpen) return "too_many_codes";
      const expiresMs = clock.now + ttlMinutes * 60_000;
      codes.push({ orgUserId, origin, hash: codeHash, consumed: false, expiresMs });
      return { expiresAt: String(expiresMs) };
    },
    async findCode(hash) {
      const c = codes.find((x) => x.hash === hash && !x.consumed && x.expiresMs > clock.now);
      return c ? { orgUserId: c.orgUserId, origin: c.origin } : null;
    },
    async consumeCode(hash) {
      const c = codes.find((x) => x.hash === hash && !x.consumed && x.expiresMs > clock.now);
      if (!c) return null;
      c.consumed = true;
      return c.orgUserId;
    },
    async insertLink({ orgUserId, issuer, services }) {
      if (links.some((l) => l.issuer === issuer && l.open)) return null;
      const id = `link-${++n}`;
      links.push({ id, orgUserId, issuer, services, createdAt: "t", open: true, closedBy: null });
      return id;
    },
    async closeLink({ linkId, closedBy }) {
      const l = links.find((x) => x.id === linkId && x.open);
      if (!l) return null;
      l.open = false;
      l.closedBy = closedBy;
      return l;
    },
    async bindPrincipals({ linkId, orgUserId, principalIds }) {
      let bound = 0;
      for (const subject of principalIds) {
        if (!principals.has(subject)) continue;
        for (const b of bindings) if (b.subject === subject && b.open && b.linkId !== linkId) b.open = false;
        if (bindings.some((b) => b.subject === subject && b.open)) continue;
        bindings.push({ subject, accountOrg: orgUserId, linkId, open: true });
        bound++;
      }
      return bound;
    },
    async closeBindings({ linkId }) {
      let closed = 0;
      for (const b of bindings) if (b.linkId === linkId && b.open) (b.open = false), closed++;
      return closed;
    },
    async orgSuspended(orgUserId) {
      return orgUserId in store.suspended ? store.suspended[orgUserId] === true : false;
    },
  };
  return store;
}
