// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { AgentGrantsStore, RoleRow, RoleState } from "../src";

export interface MemoryRole {
  principal: string;
  scope: string;
  revoked: boolean;
  /** Absent or null = pending (an ask), set = approved. */
  approvedBy?: string | null;
}

/** In-memory store with the same semantics as the Postgres adapter's SQL (a pending row opens no lock). */
export function memoryStore(init?: {
  /** `pending: true` is an ask with no approver. Default is an approved row. */
  roles?: Array<{ principal: string; scope: string; revoked?: boolean; pending?: boolean }>;
  principals?: Record<string, string>;
  names?: Record<string, string>;
  /** User ids of principals made by a service enrollment (`agent_principals.service_key` set). */
  servicePrincipals?: string[];
  failing?: boolean;
}): AgentGrantsStore & { roles: MemoryRole[] } {
  const roles: MemoryRole[] = (init?.roles ?? []).map((r) => ({
    principal: r.principal,
    scope: r.scope,
    revoked: r.revoked ?? false,
    approvedBy: r.pending ? null : "admin",
  }));
  const guard = () => {
    if (init?.failing) throw new Error("db down");
  };
  const live = (r: MemoryRole) => !r.revoked && !!r.approvedBy;
  const openRow = (principal: string, scope: string) =>
    roles.find((r) => r.principal === principal && r.scope === scope && !r.revoked);
  const slugOf = (id: string) => Object.entries(init?.principals ?? {}).find(([, v]) => v === id)?.[0] ?? null;
  return {
    roles,
    async hasLiveRole(principalId, scope) {
      guard();
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
        .filter((r, i) => !r.revoked || (!!r.approvedBy && (init?.servicePrincipals ?? []).includes(r.principal) && !roles.slice(i + 1).some((newer) => newer.principal === r.principal && newer.scope === r.scope)))
        .map(
          (r): RoleRow => ({
            principalUserId: r.principal,
            slug: slugOf(r.principal),
            internal: slugOf(r.principal) !== null,
            name: slugOf(r.principal) ? (init?.names?.[slugOf(r.principal) as string] ?? slugOf(r.principal)) : (init?.names?.[r.principal] ?? null),
            hint: null,
            scope: r.scope,
            state: r.approvedBy ? (r.revoked ? "revoked" : "granted") : "pending",
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
      const out: Array<{ scope: string; state: RoleState; at: string }> = [];
      for (const r of [...roles].reverse().filter((x) => x.principal === principalUserId)) {
        if (seen.has(r.scope)) continue;
        seen.add(r.scope);
        out.push({ scope: r.scope, state: r.approvedBy ? (r.revoked ? "revoked" : "granted") : r.revoked ? "denied" : "pending", at: "2026-11-09T00:00:00.000Z" });
      }
      return out;
    },
    async requestRole({ principalUserId, scope, maxPending, maxPendingTotal }) {
      guard();
      const open = openRow(principalUserId, scope);
      if (open) return open.approvedBy ? "granted" : "pending";
      if (roles.filter((r) => r.principal === principalUserId && !r.revoked && !r.approvedBy).length >= maxPending) return "too_many";
      if (roles.filter((r) => !r.revoked && !r.approvedBy).length >= maxPendingTotal) return "node_full";
      roles.push({ principal: principalUserId, scope, revoked: false, approvedBy: null });
      return "created";
    },
    async approvePending({ principalUserId, scope, approvedBy }) {
      guard();
      const row = openRow(principalUserId, scope);
      if (!row || row.approvedBy || principalUserId === approvedBy) return false;
      row.approvedBy = approvedBy;
      return true;
    },
    async restoreRevoked({ principalUserId, scope, approvedBy }) {
      guard();
      if (principalUserId === approvedBy) return false;
      const row = [...roles].reverse().find((r) => r.principal === principalUserId && r.scope === scope);
      if (!row?.revoked || !row.approvedBy) return false;
      roles.push({ principal: principalUserId, scope, revoked: false, approvedBy });
      return true;
    },
    async denyPending({ principalUserId, scope }) {
      guard();
      const row = openRow(principalUserId, scope);
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
      roles.push({ principal: principalUserId, scope, revoked: false, approvedBy });
      return true;
    },
    async isServicePrincipal(principalUserId) {
      guard();
      return (init?.servicePrincipals ?? []).includes(principalUserId);
    },
    async revokeRole({ principalUserId, scope }) {
      guard();
      const row = openRow(principalUserId, scope);
      if (!row || !row.approvedBy) return false;
      row.revoked = true;
      return true;
    },
  };
}
