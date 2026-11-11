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

import type { AgentGrantsStore, RoleRow, RoleState } from "./types";

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

/** `https://cognidao.org#git-review` -> `Verified service of cognidao.org`. Plain words only (TOKENLESS_COPY): no path, id or key. */
function serviceHint(serviceKey: string): string | null {
  try {
    return `Verified service of ${new URL(serviceKey.split("#")[0] ?? "").host}`;
  } catch {
    return null;
  }
}

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
        SELECT user_id, slug FROM agent_principals WHERE kind = 'internal' ORDER BY slug`;
      return rows.flatMap((row) =>
        typeof row.user_id === "string" && typeof row.slug === "string"
          ? [{ userId: row.user_id, slug: row.slug }]
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
    async listRoleRows(limit) {
      const toRow = (row: Record<string, unknown>): RoleRow | null => {
        const principalUserId = str(row.principal_user_id);
        const scope = str(row.scope);
        if (!principalUserId || !scope) return null;
        const internal = row.kind === "internal";
        const githubId = str(row.github_id);
        const serviceKey = str(row.service_key);
        return {
          principalUserId,
          slug: internal ? str(row.slug) : null,
          internal,
          name: internal ? str(row.slug) : str(row.user_name), // NAMES_ARE_IDENTIFIERS: the slug is the name
          // A proven binding, shown beside the agent's own (unproven) name. A service made by enrollment shows the node that signed for it.
          hint: serviceKey ? serviceHint(serviceKey) : githubId ? `GitHub id ${githubId}` : null,
          scope,
          state: row.approved_by ? ("granted" as const) : ("pending" as const),
          at: iso(row.created_at),
        };
      };
      // This node's own AI: always all rows (a few principals times a few scopes).
      const own = await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.created_at,
               p.slug AS slug, p.kind AS kind, u.name AS user_name,
               NULL::text AS github_id, NULL::text AS service_key
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        JOIN agent_principals p ON p.user_id = r.principal_user_id AND p.kind = 'internal'
        WHERE r.revoked_at IS NULL
        ORDER BY r.created_at`;
      // Outside agents: pending asks first, bounded. `more` says how many are cut.
      const outside = await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.created_at,
               NULL::text AS slug, 'external' AS kind, u.name AS user_name,
               (SELECT b.external_id FROM user_bindings b WHERE b.user_id = r.principal_user_id AND b.provider = 'github' LIMIT 1) AS github_id,
               (SELECT ap.service_key FROM agent_principals ap WHERE ap.user_id = r.principal_user_id) AS service_key
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        WHERE r.revoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM agent_principals p WHERE p.user_id = r.principal_user_id AND p.kind = 'internal')
        ORDER BY (r.approved_by IS NULL) DESC, r.created_at DESC
        LIMIT ${limit}`;
      const total = await sql`
        SELECT count(*)::int AS n FROM agent_roles r
        WHERE r.revoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM agent_principals p WHERE p.user_id = r.principal_user_id AND p.kind = 'internal')`;
      const rows = [...own, ...outside].flatMap((row) => {
        const mapped = toRow(row);
        return mapped ? [mapped] : [];
      });
      return { rows, more: Math.max(0, Number(total[0]?.n ?? 0) - outside.length) };
    },
    async listOwnRoles(principalUserId) {
      const rows = await sql`
        SELECT scope, approved_by, revoked_at, created_at FROM agent_roles
        WHERE principal_user_id = ${principalUserId}
        ORDER BY created_at DESC
        LIMIT 200`;
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
    async requestRole({ principalUserId, scope, maxPending, maxPendingTotal }) {
      const open = await sql`
        SELECT approved_by FROM agent_roles
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND revoked_at IS NULL LIMIT 1`;
      if (open[0]) return open[0].approved_by ? "granted" : "pending";
      const count = await sql`
        SELECT count(*)::int AS n FROM agent_roles
        WHERE principal_user_id = ${principalUserId} AND approved_by IS NULL AND revoked_at IS NULL`;
      if (Number(count[0]?.n ?? 0) >= maxPending) return "too_many";
      const all = await sql`
        SELECT count(*)::int AS n FROM agent_roles WHERE approved_by IS NULL AND revoked_at IS NULL`;
      if (Number(all[0]?.n ?? 0) >= maxPendingTotal) return "node_full";
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
          AND principal_user_id <> ${approvedBy}
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
    async isServicePrincipal(principalUserId) {
      const rows = await sql`SELECT 1 AS ok FROM agent_principals WHERE user_id = ${principalUserId} AND service_key IS NOT NULL LIMIT 1`;
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
