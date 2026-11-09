// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/postgres`
 * Purpose: The Postgres implementation of the store, over an injected tagged-template query function.
 * Scope: Raw SQL against `agent_roles` and `agent_principals`.
 *   A postgres.js `Sql` or `TransactionSql` fits `SqlTag` as is; a node adapts any other driver.
 * Invariants:
 *   - The package never creates a client, switches a role, or runs a schema.
 *   - `agent_roles` has FORCE RLS and no policy: only a service-role connection reads or writes it. `agent_principals`
 *     has a read-only select policy for every role; only a service-role connection writes it.
 * Side-effects: IO
 * @public
 */

import type { AgentGrantsStore, RoleState } from "./types";

/** A postgres.js-compatible tagged template: sql`select ${x}` resolves to rows. */
export type SqlTag = (
  strings: TemplateStringsArray,
  // `any`: postgres.js types parameters as its own union; `unknown[]` would reject a real `Sql`.
  // biome-ignore lint/suspicious/noExplicitAny: structural compatibility with postgres.js
  ...values: any[]
) => PromiseLike<ReadonlyArray<Record<string, unknown>>>;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
/** An ISO timestamp, whether the driver hands back a Date or its text form. */
const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
};

export function createPostgresAgentGrantsStore(sql: SqlTag): AgentGrantsStore {
  return {
    async hasLiveRole(principalId, scope) {
      // LIVE_NEEDS_APPROVAL: approved_by IS NOT NULL. A pending ask never opens a lock.
      const rows = await sql`
        SELECT 1 AS ok FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ${scope}
          AND approved_by IS NOT NULL AND revoked_at IS NULL
        LIMIT 1`;
      return rows.length > 0;
    },
    async liveScopes(principalId, scopes) {
      if (scopes.length === 0) return [];
      const rows = await sql`
        SELECT DISTINCT scope FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ANY(${scopes as string[]})
          AND approved_by IS NOT NULL AND revoked_at IS NULL`;
      return rows.flatMap((row) => (typeof row.scope === "string" ? [row.scope] : []));
    },
    async findInternalPrincipal(slug) {
      const rows = await sql`
        SELECT user_id FROM agent_principals
        WHERE kind = 'internal' AND slug = ${slug} LIMIT 1`;
      const userId = rows[0]?.user_id;
      return typeof userId === "string" ? { userId } : null;
    },
    async listInternalPrincipals() {
      const rows = await sql`
        SELECT user_id, slug, display_name FROM agent_principals WHERE kind = 'internal' ORDER BY slug`;
      return rows.flatMap((row) =>
        typeof row.user_id === "string" && typeof row.slug === "string"
          ? [{ userId: row.user_id, slug: row.slug, displayName: str(row.display_name) }]
          : []
      );
    },
    async listLiveRoles() {
      const rows = await sql`
        SELECT p.slug AS principal_slug, r.scope AS scope
        FROM agent_roles r
        JOIN agent_principals p ON p.user_id = r.principal_user_id AND p.kind = 'internal'
        WHERE r.approved_by IS NOT NULL AND r.revoked_at IS NULL`;
      return rows.flatMap((row) =>
        typeof row.principal_slug === "string" && typeof row.scope === "string"
          ? [{ principalSlug: row.principal_slug, scope: row.scope }]
          : []
      );
    },
    async listRoleRows() {
      const rows = await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.created_at,
               p.slug AS slug, p.kind AS kind, p.display_name AS display_name, u.name AS user_name,
               EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = r.principal_user_id AND b.provider = 'github') AS github
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        LEFT JOIN agent_principals p ON p.user_id = r.principal_user_id
        WHERE r.revoked_at IS NULL
        ORDER BY r.created_at`;
      return rows.flatMap((row) => {
        const principalUserId = str(row.principal_user_id);
        const scope = str(row.scope);
        if (!principalUserId || !scope) return [];
        const internal = row.kind === "internal";
        return [
          {
            principalUserId,
            slug: internal ? str(row.slug) : null,
            internal,
            name: internal ? (str(row.display_name) ?? str(row.slug)) : str(row.user_name),
            hint: row.github === true ? "GitHub linked" : null,
            scope,
            state: row.approved_by ? ("granted" as const) : ("pending" as const),
            at: iso(row.created_at),
          },
        ];
      });
    },
    async listOwnRoles(principalUserId) {
      const rows = await sql`
        SELECT scope, approved_by, revoked_at, created_at FROM agent_roles
        WHERE principal_user_id = ${principalUserId}
        ORDER BY created_at DESC`;
      const seen = new Set<string>();
      const out: Array<{ scope: string; state: RoleState; at: string }> = [];
      for (const row of rows) {
        const scope = str(row.scope);
        if (!scope || seen.has(scope)) continue;
        seen.add(scope);
        const approved = row.approved_by !== null && row.approved_by !== undefined;
        const revoked = row.revoked_at !== null && row.revoked_at !== undefined;
        out.push({
          scope,
          state: approved ? (revoked ? "revoked" : "granted") : revoked ? "denied" : "pending",
          at: iso(row.created_at),
        });
      }
      return out;
    },
    async requestRole({ principalUserId, scope, maxPending }) {
      const open = await sql`
        SELECT approved_by FROM agent_roles
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND revoked_at IS NULL LIMIT 1`;
      if (open[0]) return open[0].approved_by ? "granted" : "pending";
      const count = await sql`
        SELECT count(*)::int AS n FROM agent_roles
        WHERE principal_user_id = ${principalUserId} AND approved_by IS NULL AND revoked_at IS NULL`;
      if (Number(count[0]?.n ?? 0) >= maxPending) return "too_many";
      const inserted = await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by)
        VALUES (${principalUserId}, ${scope}, NULL, ${principalUserId})
        ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`;
      return inserted.length > 0 ? "created" : "pending";
    },
    async approvePending({ principalUserId, scope, approvedBy }) {
      const rows = await sql`
        UPDATE agent_roles SET approved_by = ${approvedBy}, granted_at = now()
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          AND approved_by IS NULL AND revoked_at IS NULL
        RETURNING id`;
      return rows.length > 0;
    },
    async denyPending({ principalUserId, scope }) {
      const rows = await sql`
        UPDATE agent_roles SET revoked_at = now()
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          AND approved_by IS NULL AND revoked_at IS NULL
        RETURNING id`;
      return rows.length > 0;
    },
    async insertRole({ principalUserId, scope, approvedBy }) {
      const rows = await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at)
        VALUES (${principalUserId}, ${scope}, ${approvedBy}, now())
        ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`;
      return rows.length > 0;
    },
    async revokeRole({ principalUserId, scope }) {
      const rows = await sql`
        UPDATE agent_roles SET revoked_at = now()
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          AND approved_by IS NOT NULL AND revoked_at IS NULL
        RETURNING id`;
      return rows.length > 0;
    },
  };
}
