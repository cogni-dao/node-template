// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { OrgError, type OpenInvite, type OrgAccountStore, type OrgLinkStore, type OrgMember, type OrgMembership, type OrgRecord, type OpenLink, type OrgRole, type Page, pageOf } from "../src";

/** The same keyset paging as the SQL: ordered by key, `after` exclusive, one extra row decides the cursor. */
function pageBy<T>(rows: readonly T[], keyOf: (row: T) => string, input: { limit: number; after: string | null }): Page<T> {
  const sorted = [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const rest = input.after === null ? sorted : sorted.filter((row) => keyOf(row) > (input.after as string));
  return pageOf(rest.slice(0, input.limit + 1), input.limit, keyOf);
}

const uuidN = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Role {
  id: string;
  userId: string;
  orgUserId: string;
  role: OrgRole;
  approvedBy: string;
  at: number;
  live: boolean;
  /** Who ended it (a person), or null while live. */
  revokedBy: string | null;
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
  const store: OrgAccountStore & {
    orgs: typeof orgs;
    roles: Role[];
    invites: Invite[];
    locks: string[];
    clock: typeof clock;
    addWallet(userId: string, wallet: string): void;
    suspendedBy: Record<string, string>;
    createdBy: Record<string, string>;
  } = {
    suspendedBy: {},
    createdBy: {},
    orgs,
    roles,
    invites,
    locks: [],
    clock,
    addWallet: (userId, wallet) => {
      wallets[userId] = [...(wallets[userId] ?? []), wallet];
    },
    async createOrg({ creatorUserId, name, maxOwned }) {
      if (owned(creatorUserId) >= maxOwned) return "org_role_limit";
      const orgUserId = `org-${++n}`;
      store.createdBy[orgUserId] = creatorUserId;
      orgs.set(orgUserId, { orgUserId, name, billingAccountId: `acct-${orgUserId}`, suspendedAt: null, balanceCredits: 0 });
      roles.push({ id: uuidN(++n), userId: creatorUserId, orgUserId, role: "owner", approvedBy: orgUserId, at: clock.now, live: true, revokedBy: null });
      return { orgUserId, billingAccountId: `acct-${orgUserId}` };
    },
    async listAll(input) {
      const page = pageBy([...orgs.values()], (o) => o.orgUserId, input);
      return { items: page.items.map((o) => ({ orgUserId: o.orgUserId, name: o.name, suspended: o.suspendedAt !== null })), nextCursor: page.nextCursor };
    },
    async getOrg(orgUserId) {
      return orgs.get(orgUserId) ?? null;
    },
    async listOrgsOf(userId, input): Promise<Page<OrgMembership>> {
      const mine = [...orgs.values()].flatMap((o): OrgMembership[] => {
        const role = roleOf(userId, o.orgUserId);
        return role ? [{ ...o, role }] : [];
      });
      return pageBy(mine, (o) => o.orgUserId, input);
    },
    roleOf: async (userId, orgUserId) => roleOf(userId, orgUserId),
    async members(orgUserId, input): Promise<Page<OrgMember>> {
      const page = pageBy(live(orgUserId), (r) => r.id, input);
      return { items: page.items.map((r) => ({ userId: r.userId, name: r.userId, wallet: (wallets[r.userId] ?? [])[0] ?? null, role: r.role, since: String(r.at) })), nextCursor: page.nextCursor };
    },
    async lockOwners(orgUserId) {
      store.locks.push(`owners:${orgUserId}`);
      return live(orgUserId).filter((r) => r.role === "owner").map((r) => r.userId);
    },
    async lockAndCountOwned(userId) {
      store.locks.push(`person:${userId}`);
      return owned(userId);
    },
    async setRole({ orgUserId, userId, role, approvedBy, revokedBy }) {
      if (approvedBy === userId) throw new Error("agent_roles_no_self_approval");
      // The release-1 limit: the old (principal, scope) index refuses the same role in ANOTHER org.
      const elsewhere = roles.find((r) => r.live && r.userId === userId && r.role === role && r.orgUserId !== orgUserId);
      for (const r of roles) {
        if (r.orgUserId === orgUserId && r.userId === userId && r.live) {
          r.live = false;
          r.revokedBy = revokedBy;
        }
      }
      if (elsewhere) throw new OrgError("org_role_limit");
      roles.push({ id: uuidN(++n), userId, orgUserId, role, approvedBy, at: clock.now, live: true, revokedBy: null });
    },
    async removeRole({ orgUserId, userId, revokedBy }) {
      const mine = live(orgUserId).filter((r) => r.userId === userId);
      for (const r of mine) {
        r.live = false;
        r.revokedBy = revokedBy;
      }
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
      const invite: Invite = { id: uuidN(++n), orgUserId, orgName: orgs.get(orgUserId)?.name ?? "", role, invitedBy, wallet, open: true, expiresMs, expiresAt: String(expiresMs) };
      invites.push(invite);
      return { id: invite.id, expiresAt: invite.expiresAt };
    },
    async invitesFor(userId, inviteId, input) {
      const mine = wallets[userId] ?? [];
      return pageBy(
        invites.filter((i) => i.open && i.expiresMs > clock.now && mine.includes(i.wallet) && (inviteId === null || i.id === inviteId)),
        (i) => i.id,
        input
      );
    },
    async consumeInvite({ inviteId, userId }) {
      const invite = invites.find((i) => i.id === inviteId);
      if (!invite || !invite.open || invite.expiresMs <= clock.now || !(wallets[userId] ?? []).includes(invite.wallet)) return false;
      invite.open = false;
      return true;
    },
    async suspend(orgUserId, adminUserId) {
      const org = orgs.get(orgUserId);
      if (!org) return false;
      orgs.set(orgUserId, { ...org, suspendedAt: org.suspendedAt ?? "now" });
      store.suspendedBy[orgUserId] ??= adminUserId;
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
  createdBy: string;
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
  const links: Array<OpenLink & { open: boolean; closedBy: string | null; createdBy?: string }> = [];
  const bindings: Binding[] = [];
  const principals = new Set<string>();
  let n = 0;
  const store: OrgLinkStore & { codes: Code[]; links: typeof links; bindings: Binding[]; principals: Set<string>; clock: typeof clock; suspended: Record<string, boolean>; names: Record<string, string>; locks: string[] } = {
    locks: [],
    names: {},
    codes,
    links,
    bindings,
    principals,
    clock,
    suspended: orgs.suspended ?? {},
    async openLinkOfIssuer(issuer) {
      return links.find((l) => l.issuer === issuer && l.open) ?? null;
    },
    async openLinksOfOrg(orgUserId, input) {
      return pageBy(links.filter((l) => l.orgUserId === orgUserId && l.open), (l) => l.id, input);
    },
    async createCode({ orgUserId, origin, codeHash, createdBy, ttlMinutes, maxOpen }) {
      store.locks.push(`org:${orgUserId}`);
      if (codes.filter((c) => c.orgUserId === orgUserId && !c.consumed && c.expiresMs > clock.now).length >= maxOpen) return "too_many_codes";
      const expiresMs = clock.now + ttlMinutes * 60_000;
      codes.push({ orgUserId, origin, hash: codeHash, consumed: false, expiresMs, createdBy });
      return { expiresAt: String(expiresMs) };
    },
    async findCode(hash) {
      const c = codes.find((x) => x.hash === hash && !x.consumed && x.expiresMs > clock.now);
      return c ? { orgUserId: c.orgUserId, origin: c.origin } : null;
    },
    async codePreview(hash) {
      const c = codes.find((x) => x.hash === hash && !x.consumed && x.expiresMs > clock.now);
      return c ? { orgUserId: c.orgUserId, origin: c.origin, orgName: store.names[c.orgUserId] ?? c.orgUserId } : null;
    },
    async consumeCode(hash) {
      const c = codes.find((x) => x.hash === hash && !x.consumed && x.expiresMs > clock.now);
      if (!c) return null;
      c.consumed = true;
      return { orgUserId: c.orgUserId, createdBy: c.createdBy };
    },
    async lockIssuer(issuer) {
      store.locks.push(`issuer:${issuer}`);
    },
    async lockOrg(orgUserId) {
      store.locks.push(`org:${orgUserId}`);
    },
    async insertLink({ orgUserId, issuer, services, createdBy }) {
      if (links.some((l) => l.issuer === issuer && l.open)) return null;
      const id = `link-${++n}`;
      links.push({ id, orgUserId, issuer, services, createdAt: "t", open: true, closedBy: null, createdBy });
      return id;
    },
    async closeLinkOfOrg({ linkId, orgUserId, closedBy }) {
      const l = links.find((x) => x.id === linkId && x.orgUserId === orgUserId && x.open);
      if (!l) return null;
      l.open = false;
      l.closedBy = closedBy;
      return l;
    },
    async closeLink({ linkId, closedBy }) {
      const l = links.find((x) => x.id === linkId && x.open);
      if (!l) return null;
      l.open = false;
      l.closedBy = closedBy;
      return l;
    },
    async bindPrincipals({ linkId, orgUserId, principalIds }) {
      // The link must be open (the SQL locks it FOR SHARE and binds only then).
      if (!links.some((l) => l.id === linkId && l.orgUserId === orgUserId && l.open)) return 0;
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
