// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { AgentGrantsStore, GrantResource, PendingAskView, RoleRow, RoleState } from "../src";

export interface MemoryRole {
  id: string;
  principal: string;
  scope: string;
  revoked: boolean;
  /** Absent or null = pending (an ask), set = approved. */
  approvedBy?: string | null;
  resource: GrantResource;
  accountId: string | null;
  /** ms since epoch on the store clock; null on a node row. */
  grantedAt: number | null;
  expiresAt: number | null;
  /** The moment of revoke on the store clock (null while not revoked). */
  revokedAt: number | null;
  linkHash: string | null;
  linkExpiresAt: number | null;
  linkConsumed: boolean;
  seq: number;
}

export interface MemoryClock {
  now: number;
}

/** In-memory store with the same semantics as the Postgres adapter's SQL (a pending row opens no lock; an account row is live only before expires_at). */
export function memoryStore(init?: {
  /** `pending: true` is an ask with no approver. Default is an approved row. */
  roles?: Array<{
    principal: string;
    scope: string;
    revoked?: boolean;
    pending?: boolean;
    resource?: GrantResource;
    accountId?: string;
    /** ms from now; negative = already ended. */
    expiresInMs?: number;
  }>;
  principals?: Record<string, string>;
  names?: Record<string, string>;
  /** user id -> the billing account id that user owns. */
  accounts?: Record<string, string>;
  failing?: boolean;
}): AgentGrantsStore & { roles: MemoryRole[]; clock: MemoryClock } {
  const clock: MemoryClock = { now: Date.now() };
  let seq = 0;
  const DAY = 86_400_000;
  const mk = (
    r: Pick<MemoryRole, "principal" | "scope"> & Partial<MemoryRole>
  ): MemoryRole => ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    revoked: false,
    approvedBy: null,
    resource: "node",
    accountId: null,
    grantedAt: null,
    expiresAt: null,
    revokedAt: null,
    linkHash: null,
    linkExpiresAt: null,
    linkConsumed: false,
    seq,
    ...r,
  });
  const roles: MemoryRole[] = (init?.roles ?? []).map((r) => {
    const resource = r.resource ?? "node";
    const approved = !r.pending;
    return mk({
      principal: r.principal,
      scope: r.scope,
      revoked: r.revoked ?? false,
      revokedAt: r.revoked ? clock.now : null,
      approvedBy: approved ? "admin" : null,
      resource,
      accountId: resource === "account" && approved ? (r.accountId ?? null) : null,
      grantedAt: approved ? clock.now - 2 * DAY : null,
      expiresAt: resource === "account" && approved ? clock.now + (r.expiresInMs ?? DAY) : null,
    });
  });
  const guard = () => {
    if (init?.failing) throw new Error("db down");
  };
  const owns = (userId: string, accountId: string) => init?.accounts?.[userId] === accountId;
  const liveNode = (r: MemoryRole) => r.resource === "node" && !r.revoked && !!r.approvedBy;
  const liveAccount = (r: MemoryRole) =>
    r.resource === "account" && !r.revoked && !!r.approvedBy && r.expiresAt !== null && r.expiresAt > clock.now;
  const openRow = (principal: string, scope: string) =>
    roles.find((r) => r.principal === principal && r.scope === scope && !r.revoked);
  const slugOf = (id: string) => Object.entries(init?.principals ?? {}).find(([, v]) => v === id)?.[0] ?? null;
  const nameOf = (id: string): string | null => {
    const slug = slugOf(id);
    return slug ? (init?.names?.[slug] ?? slug) : (init?.names?.[id] ?? null);
  };
  const toView = (r: MemoryRole): RoleRow => ({
    principalUserId: r.principal,
    slug: slugOf(r.principal),
    internal: slugOf(r.principal) !== null,
    name: nameOf(r.principal),
    hint: null,
    scope: r.scope,
    state: r.approvedBy ? "granted" : "pending",
    at: "2026-11-09T00:00:00.000Z",
    rowId: r.id,
    resource: r.resource,
    accountId: r.accountId,
    expiresAt: r.expiresAt === null ? null : new Date(r.expiresAt).toISOString(),
  });
  const closeExpired = (principal: string, scope: string) => {
    for (const r of roles)
      if (r.principal === principal && r.scope === scope && r.resource === "account" && !!r.approvedBy && !r.revoked && r.expiresAt !== null && r.expiresAt <= clock.now) {
        r.revoked = true;
        r.revokedAt = clock.now;
      }
  };
  const byLink = (linkHash: string, resource: GrantResource) =>
    roles.find(
      (r) =>
        r.linkHash === linkHash &&
        r.resource === resource &&
        !r.approvedBy &&
        !r.revoked &&
        !r.linkConsumed &&
        r.linkExpiresAt !== null &&
        r.linkExpiresAt > clock.now
    );
  const isInternal = (id: string) => slugOf(id) !== null;
  return {
    roles,
    clock,
    async hasLiveRole(principalId, scope) {
      guard();
      return roles.some((r) => r.principal === principalId && r.scope === scope && liveNode(r));
    },
    async liveScopes(principalId, scopes) {
      guard();
      return [...new Set(roles.filter((r) => r.principal === principalId && liveNode(r) && scopes.includes(r.scope)).map((r) => r.scope))];
    },
    async hasLiveAccountGrant(principalId, scope, accountId) {
      guard();
      return roles.some((r) => r.principal === principalId && r.scope === scope && r.accountId === accountId && liveAccount(r));
    },
    async liveAccountScopes(principalId, scopes, accountId) {
      guard();
      return [...new Set(roles.filter((r) => r.principal === principalId && r.accountId === accountId && liveAccount(r) && scopes.includes(r.scope)).map((r) => r.scope))];
    },
    async ownsAccount(userId, accountId) {
      guard();
      return owns(userId, accountId);
    },
    async accountOf(userId) {
      guard();
      return init?.accounts?.[userId] ?? null;
    },
    async listLiveRoles() {
      return roles
        .filter((r) => liveNode(r) && slugOf(r.principal))
        .map((r) => ({ principalSlug: slugOf(r.principal) as string, scope: r.scope }));
    },
    async listInternalPrincipals() {
      return Object.entries(init?.principals ?? {}).map(([slug, userId]) => ({ userId, slug }));
    },
    async listRoleRows(limit) {
      const all = roles.filter((r) => r.resource === "node" && !r.revoked).map(toView);
      // Same contract as the SQL: this node's own AI always in full; outside rows bounded, pending first.
      const mine = all.filter((r) => r.internal);
      const outside = all.filter((r) => !r.internal).sort((a, b) => (a.state === b.state ? 0 : a.state === "pending" ? -1 : 1));
      return { rows: [...mine, ...outside.slice(0, limit)], more: Math.max(0, outside.length - limit) };
    },
    async listAccountRoleRows(accountId, limit) {
      return roles
        .filter((r) => r.accountId === accountId && liveAccount(r))
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .map(toView);
    },
    async listOwnRoles(principalUserId) {
      const seen = new Set<string>();
      const out: Array<{ scope: string; state: RoleState; at: string; accountId: string | null }> = [];
      for (const r of [...roles].reverse().filter((x) => x.principal === principalUserId)) {
        const key = `${r.scope}\u0000${r.accountId ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const expired = r.expiresAt !== null && r.expiresAt <= (r.revokedAt ?? clock.now);
        const state: RoleState = r.approvedBy ? (expired ? "expired" : r.revoked ? "revoked" : "granted") : r.revoked ? "denied" : "pending";
        out.push({ scope: r.scope, state, at: "2026-11-09T00:00:00.000Z", accountId: r.accountId });
      }
      return out;
    },
    async requestRole({ principalUserId, scope, resource, link, maxPending, maxPendingTotal }) {
      guard();
      closeExpired(principalUserId, scope);
      const open = openRow(principalUserId, scope);
      if (open) {
        if (open.approvedBy) return "granted";
        open.linkHash = link.hash;
        open.linkExpiresAt = link.expiresAt.getTime();
        open.linkConsumed = false;
        return "pending";
      }
      if (roles.filter((r) => r.principal === principalUserId && !r.revoked && !r.approvedBy).length >= maxPending) return "too_many";
      if (roles.filter((r) => !r.revoked && !r.approvedBy).length >= maxPendingTotal) return "node_full";
      roles.push(mk({ principal: principalUserId, scope, resource, linkHash: link.hash, linkExpiresAt: link.expiresAt.getTime() }));
      return "created";
    },
    async approvePending({ principalUserId, scope, approvedBy }) {
      guard();
      const row = openRow(principalUserId, scope);
      if (!row || row.resource !== "node" || row.approvedBy || principalUserId === approvedBy) return false;
      row.approvedBy = approvedBy;
      row.grantedAt = clock.now;
      row.linkHash = null;
      return true;
    },
    async denyPending({ principalUserId, scope }) {
      guard();
      const row = openRow(principalUserId, scope);
      if (!row || row.resource !== "node" || row.approvedBy) return false;
      row.revoked = true;
      row.revokedAt = clock.now;
      row.linkHash = null;
      return true;
    },
    async findInternalPrincipal(slug) {
      guard();
      const userId = init?.principals?.[slug];
      return userId ? { userId } : null;
    },
    async insertRole({ principalUserId, scope, approvedBy }) {
      guard();
      if (!isInternal(principalUserId) || principalUserId === approvedBy) return false;
      if (openRow(principalUserId, scope)) return false;
      roles.push(mk({ principal: principalUserId, scope, approvedBy, grantedAt: clock.now }));
      return true;
    },
    async revokeRole({ principalUserId, scope }) {
      guard();
      const row = openRow(principalUserId, scope);
      if (!row || row.resource !== "node" || !row.approvedBy) return false;
      row.revoked = true;
      row.revokedAt = clock.now;
      return true;
    },
    async findPendingByLink({ linkHash, resource }) {
      guard();
      const r = byLink(linkHash, resource);
      if (!r) return null;
      const view: PendingAskView = {
        principalUserId: r.principal,
        slug: slugOf(r.principal),
        internal: isInternal(r.principal),
        name: nameOf(r.principal),
        hint: null,
        scope: r.scope,
        resource: r.resource,
        at: "2026-11-09T00:00:00.000Z",
      };
      return view;
    },
    async approveAccountByLink({ linkHash, approvedBy, days }) {
      guard();
      const r = byLink(linkHash, "account");
      const account = init?.accounts?.[approvedBy];
      if (!r || !account || r.principal === approvedBy) return false;
      r.approvedBy = approvedBy;
      r.grantedAt = clock.now;
      r.accountId = account;
      r.expiresAt = clock.now + days * DAY;
      r.linkConsumed = true;
      r.linkHash = null;
      return true;
    },
    async denyAccountByLink({ linkHash, deniedBy }) {
      guard();
      const r = byLink(linkHash, "account");
      if (!r || r.principal === deniedBy || !init?.accounts?.[deniedBy]) return false;
      r.revoked = true;
      r.revokedAt = clock.now;
      r.linkConsumed = true;
      r.linkHash = null;
      return true;
    },
    async insertAccountRole({ principalUserId, scope, approvedBy, days }) {
      guard();
      const account = init?.accounts?.[approvedBy];
      if (!account || principalUserId === approvedBy || !isInternal(principalUserId)) return false;
      closeExpired(principalUserId, scope);
      if (openRow(principalUserId, scope)) return false;
      roles.push(mk({ principal: principalUserId, scope, approvedBy, resource: "account", accountId: account, grantedAt: clock.now, expiresAt: clock.now + days * DAY }));
      return true;
    },
    async revokeAccountRole({ rowId, ownerUserId }) {
      guard();
      const r = roles.find((x) => x.id === rowId);
      if (!r || r.resource !== "account" || !r.approvedBy || r.revoked || !r.accountId || !owns(ownerUserId, r.accountId)) return false;
      r.revoked = true;
      r.revokedAt = clock.now;
      return true;
    },
  };
}
