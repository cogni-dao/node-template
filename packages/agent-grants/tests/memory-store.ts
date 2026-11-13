// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { type AgentGrantsStore, type GrantResource, type OwnRoleRow, PERSONAL_GRANT_TTL_DAYS, type PersonalRow, type RoleRow } from "../src";

export interface MemoryRole {
  principal: string;
  scope: string;
  revoked: boolean;
  /** Absent or null = pending (an ask), set = approved. */
  approvedBy?: string | null;
  /** `node` (default) or a personal kind. A personal row names its owner. */
  kind: "node" | "own" | "account";
  owner: string | null;
  /** Epoch ms. Set on an approved personal row. */
  expiresAt: number | null;
}

/** In-memory store with the same semantics as the Postgres adapter's SQL (a pending row opens no lock). */
export function memoryStore(init?: {
  /** `pending: true` is an ask with no approver. Default is an approved row. */
  roles?: Array<{
    principal: string;
    scope: string;
    revoked?: boolean;
    pending?: boolean;
    kind?: "node" | "own" | "account";
    /** A personal row's owner; it is also the approver unless `approvedBy` says otherwise. */
    owner?: string;
    approvedBy?: string;
    /** Epoch ms; default for an approved personal row is a day from `store.now()`. */
    expiresAt?: number;
  }>;
  principals?: Record<string, string>;
  names?: Record<string, string>;
  /** agent user id -> the person who owns it (`agent_principals.owner_user_id`). */
  owners?: Record<string, string>;
  /** billing account id -> its owner. */
  accounts?: Record<string, string>;
  failing?: boolean;
}): AgentGrantsStore & { roles: MemoryRole[]; clock: { now: number } } {
  const clock = { now: Date.UTC(2026, 10, 12) };
  const roles: MemoryRole[] = (init?.roles ?? []).map((r) => {
    const kind = r.kind ?? "node";
    const approvedBy = r.pending ? null : (r.approvedBy ?? (kind === "node" ? "admin" : (r.owner ?? "admin")));
    return {
      principal: r.principal,
      scope: r.scope,
      revoked: r.revoked ?? false,
      approvedBy,
      kind,
      owner: kind === "node" ? null : (r.owner ?? null),
      expiresAt: kind !== "node" && approvedBy ? (r.expiresAt ?? clock.now + 86_400_000) : null,
    };
  });
  const guard = () => {
    if (init?.failing) throw new Error("db down");
  };
  const live = (r: MemoryRole) => r.kind === "node" && !r.revoked && !!r.approvedBy;
  // The same predicate as the SQL (`hasLiveRole` personal branch / `agent_has_scope`).
  const livePersonal = (r: MemoryRole, resource: { kind: string; ownerUserId: string }) =>
    r.kind === resource.kind &&
    r.owner === resource.ownerUserId &&
    r.approvedBy === r.owner &&
    !r.revoked &&
    r.expiresAt !== null &&
    r.expiresAt > clock.now &&
    init?.owners?.[r.principal] === r.owner;
  const isPersonal = (resource?: GrantResource): resource is Exclude<GrantResource, { kind: "node" }> => !!resource && resource.kind !== "node";
  const ended = (r: MemoryRole) => r.expiresAt !== null && r.expiresAt <= clock.now;
  const openRow = (principal: string, scope: string, resource?: GrantResource) =>
    roles.find(
      (r) =>
        r.principal === principal &&
        r.scope === scope &&
        !r.revoked &&
        (isPersonal(resource) ? r.kind !== "node" && r.owner === resource.ownerUserId : r.kind === "node")
    );
  const slugOf = (id: string) => Object.entries(init?.principals ?? {}).find(([, v]) => v === id)?.[0] ?? null;
  return {
    roles,
    clock,
    async hasLiveRole(principalId, scope, resource) {
      guard();
      if (isPersonal(resource)) return roles.some((r) => r.principal === principalId && r.scope === scope && livePersonal(r, resource));
      return roles.some((r) => r.principal === principalId && r.scope === scope && live(r));
    },
    async liveScopes(principalId, scopes) {
      guard();
      return [...new Set(roles.filter((r) => r.principal === principalId && live(r) && scopes.includes(r.scope)).map((r) => r.scope))];
    },
    async listLiveRoles() {
      return roles
        .filter((r) => live(r) && slugOf(r.principal))
        .map((r) => ({ principalSlug: slugOf(r.principal) as string, scope: r.scope }));
    },
    async listInternalPrincipals() {
      return Object.entries(init?.principals ?? {}).map(([slug, userId]) => ({ userId, slug }));
    },
    async listRoleRows(limit) {
      const all = roles
        .filter((r) => !r.revoked && r.kind === "node")
        .map(
          (r): RoleRow => ({
            principalUserId: r.principal,
            slug: slugOf(r.principal),
            internal: slugOf(r.principal) !== null,
            name: slugOf(r.principal) ? (init?.names?.[slugOf(r.principal) as string] ?? slugOf(r.principal)) : (init?.names?.[r.principal] ?? null),
            hint: null,
            scope: r.scope,
            state: r.approvedBy ? "granted" : "pending",
            at: "2026-11-09T00:00:00.000Z",
          })
        );
      // Same contract as the SQL: this node's own AI always in full; outside rows bounded, pending first.
      const mine = all.filter((r) => r.internal);
      const outside = all.filter((r) => !r.internal).sort((a, b) => (a.state === b.state ? 0 : a.state === "pending" ? -1 : 1));
      return { rows: [...mine, ...outside.slice(0, limit)], more: Math.max(0, outside.length - limit) };
    },
    async listOwnRoles(principalUserId) {
      const seen = new Set<string>();
      const out: OwnRoleRow[] = [];
      for (const r of [...roles].reverse().filter((x) => x.principal === principalUserId)) {
        if (seen.has(r.scope)) continue;
        seen.add(r.scope);
        const approved = !!r.approvedBy;
        const granted = approved && !r.revoked && !ended(r);
        const accountId =
          granted && r.kind === "account" ? Object.entries(init?.accounts ?? {}).find(([, owner]) => owner === r.owner)?.[0] : undefined;
        out.push({
          scope: r.scope,
          state: granted ? "granted" : approved ? "revoked" : r.revoked ? "denied" : "pending",
          at: "2026-11-09T00:00:00.000Z",
          ...(accountId ? { accountId } : {}),
        });
      }
      return out;
    },
    async requestRole({ principalUserId, scope, maxPending, maxPendingTotal, resource }) {
      guard();
      if (isPersonal(resource)) {
        for (const r of roles) if (r.principal === principalUserId && r.scope === scope && r.kind !== "node" && !r.revoked && ended(r)) r.revoked = true;
        const open = openRow(principalUserId, scope, resource);
        if (open) return open.approvedBy ? "granted" : "pending";
        if (roles.filter((r) => r.principal === principalUserId && !r.revoked && !r.approvedBy).length >= maxPending) return "too_many";
        roles.push({ principal: principalUserId, scope, revoked: false, approvedBy: null, kind: resource.kind, owner: resource.ownerUserId, expiresAt: null });
        return "created";
      }
      const open = openRow(principalUserId, scope);
      if (open) return open.approvedBy ? "granted" : "pending";
      if (roles.filter((r) => r.principal === principalUserId && r.kind === "node" && !r.revoked && !r.approvedBy).length >= maxPending) return "too_many";
      if (roles.filter((r) => r.kind === "node" && !r.revoked && !r.approvedBy).length >= maxPendingTotal) return "node_full";
      roles.push({ principal: principalUserId, scope, revoked: false, approvedBy: null, kind: "node", owner: null, expiresAt: null });
      return "created";
    },
    async approvePending({ principalUserId, scope, approvedBy, resource, ttlDays }) {
      guard();
      const row = openRow(principalUserId, scope, resource);
      if (!row || row.approvedBy || principalUserId === approvedBy) return false;
      if (isPersonal(resource)) {
        if (row.owner !== approvedBy) return false; // only the owner approves a personal row
        row.expiresAt = clock.now + (ttlDays ?? PERSONAL_GRANT_TTL_DAYS) * 86_400_000;
      }
      row.approvedBy = approvedBy;
      return true;
    },
    async denyPending({ principalUserId, scope, resource }) {
      guard();
      const row = openRow(principalUserId, scope, resource);
      if (!row || row.approvedBy) return false;
      row.revoked = true;
      return true;
    },
    async findInternalPrincipal(slug) {
      guard();
      const userId = init?.principals?.[slug];
      return userId ? { userId } : null;
    },
    async insertRole({ principalUserId, scope, approvedBy }) {
      guard();
      if (openRow(principalUserId, scope)) return false;
      roles.push({ principal: principalUserId, scope, revoked: false, approvedBy, kind: "node", owner: null, expiresAt: null });
      return true;
    },
    async revokeRole({ principalUserId, scope, resource }) {
      guard();
      const row = openRow(principalUserId, scope, resource);
      if (!row || !row.approvedBy) return false;
      row.revoked = true;
      return true;
    },
    async agentOwner(principalUserId) {
      guard();
      return init?.owners?.[principalUserId] ?? null;
    },
    async accountOwner(accountId) {
      guard();
      return init?.accounts?.[accountId] ?? null;
    },
    async listPersonalRows(ownerUserId): Promise<PersonalRow[]> {
      guard();
      return roles
        .filter((r) => r.kind !== "node" && r.owner === ownerUserId && !r.revoked && (!r.approvedBy || !ended(r)) && init?.owners?.[r.principal] === ownerUserId)
        .map((r) => ({
          principalUserId: r.principal,
          name: init?.names?.[r.principal] ?? null,
          scope: r.scope,
          state: r.approvedBy ? ("granted" as const) : ("pending" as const),
          expiresAt: r.approvedBy && r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
          at: "2026-11-09T00:00:00.000Z",
        }));
    },
  };
}
