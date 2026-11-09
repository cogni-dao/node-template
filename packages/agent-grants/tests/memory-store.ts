// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { AgentGrantsStore } from "../src";

/** In-memory store with the same semantics as the Postgres adapter's SQL. */
export function memoryStore(init?: {
  roles?: Array<{ principal: string; scope: string; revoked?: boolean }>;
  principals?: Record<string, string>;
  failing?: boolean;
}): AgentGrantsStore & { roles: Array<{ principal: string; scope: string; revoked: boolean; approvedBy?: string }> } {
  const roles = (init?.roles ?? []).map((r) => ({ ...r, revoked: r.revoked ?? false }));
  const guard = () => {
    if (init?.failing) throw new Error("db down");
  };
  return {
    roles,
    async hasLiveRole(principalId, scope) {
      guard();
      return roles.some((r) => r.principal === principalId && r.scope === scope && !r.revoked);
    },
    async listLiveRoles() {
      const bySlug = new Map(Object.entries(init?.principals ?? {}).map(([slug, id]) => [id, slug]));
      return roles
        .filter((r) => !r.revoked && bySlug.has(r.principal))
        .map((r) => ({ principalSlug: bySlug.get(r.principal) as string, scope: r.scope }));
    },
    async findInternalPrincipal(slug) {
      guard();
      const userId = init?.principals?.[slug];
      return userId ? { userId } : null;
    },
    async insertRole({ principalUserId, scope, approvedBy }) {
      guard();
      if (roles.some((r) => r.principal === principalUserId && r.scope === scope && !r.revoked)) return false;
      roles.push({ principal: principalUserId, scope, revoked: false, approvedBy });
      return true;
    },
    async revokeRole({ principalUserId, scope }) {
      guard();
      const row = roles.find((r) => r.principal === principalUserId && r.scope === scope && !r.revoked);
      if (!row) return false;
      row.revoked = true;
      return true;
    },
  };
}
