// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/postgres`
 * Purpose: The Postgres implementation of the store, over an injected tagged-template query function.
 * Scope: Raw SQL against `agent_roles` and `agent_principals`.
 *   A postgres.js `Sql` or `TransactionSql` fits `SqlTag` as is; writes require a begin-capable client or transaction-bound tag.
 *   Role mutations take the user lock before reading or changing authority, so provider maintenance can coordinate with the same writer.
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
  // Lock order for authority writers: user -> enrollment (provider only) -> role -> credential.
  // A root postgres client opens a transaction; a transaction-bound tag reuses its caller's transaction.
  const mutate = <T>(principalUserId: string, fn: (tx: SqlTag) => Promise<T>): Promise<T> => {
    const run = async (tx: SqlTag): Promise<T> => {
      await tx`SELECT id FROM users WHERE id = ${principalUserId} FOR UPDATE`;
      return fn(tx);
    };
    const client = sql as SqlTag & { begin?: <R>(f: (tx: SqlTag) => Promise<R>) => Promise<R>; savepoint?: unknown };
    if (client.begin) return client.begin(run);
    if (typeof client.savepoint === "function") return run(sql);
    return Promise.reject(new Error("role writer requires a begin-capable client or a transaction-bound SQL tag"));
  };
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
    async listRoleRows(limit, declaredScopes = []) {
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
          state: row.approved_by ? (row.revoked_at ? "revoked" as const : "granted" as const) : "pending" as const,
          at: iso(row.created_at),
        };
      };
      // This node's own AI: always all rows (a few principals times a few scopes).
      const own = await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.revoked_at, r.created_at,
               p.slug AS slug, p.kind AS kind, u.name AS user_name,
               NULL::text AS github_id, NULL::text AS service_key
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        JOIN agent_principals p ON p.user_id = r.principal_user_id AND p.kind = 'internal'
        WHERE r.revoked_at IS NULL
        ORDER BY r.created_at`;
      // Outside agents: pending asks first, bounded. `more` says how many are cut.
      const outside = await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.revoked_at, r.created_at,
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
      // Only the bounded enrolled-principal x declared-scope set needs historical Off controls. Each lookup reads one indexed latest row,
      // rather than walking retained role history. Ordinary external-agent listing keeps its existing live/pending behavior.
      const off = declaredScopes.length === 0 ? [] : await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.revoked_at, r.created_at,
               NULL::text AS slug, 'external' AS kind, u.name AS user_name, NULL::text AS github_id, p.service_key
        FROM (SELECT user_id, service_key FROM agent_principals WHERE service_key IS NOT NULL ORDER BY user_id LIMIT 25) p
        CROSS JOIN unnest(${declaredScopes as string[]}::text[]) s(scope)
        CROSS JOIN LATERAL (
          SELECT principal_user_id, scope, approved_by, revoked_at, created_at FROM agent_roles
          WHERE principal_user_id = p.user_id AND scope = s.scope
          ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT 1
        ) r
        JOIN users u ON u.id = p.user_id
        WHERE r.approved_by IS NOT NULL AND r.revoked_at IS NOT NULL
        ORDER BY r.created_at DESC`;
      const controls = [...outside, ...off].sort((a, b) => Number(b.approved_by == null) - Number(a.approved_by == null) || iso(b.created_at).localeCompare(iso(a.created_at)));
      const rows = [...own, ...controls.slice(0, limit)].flatMap((row) => {
        const mapped = toRow(row);
        return mapped ? [mapped] : [];
      });
      return { rows, more: Math.max(0, Number(total[0]?.n ?? 0) + off.length - limit) };
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
      return mutate(principalUserId, async (sql) => {
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
          INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by, created_at)
          VALUES (${principalUserId}, ${scope}, NULL, ${principalUserId}, clock_timestamp())
          ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
          RETURNING id`;
        return inserted.length > 0 ? "created" : "pending";
      });
    },
    async approvePending({ principalUserId, scope, approvedBy }) {
      return mutate(principalUserId, async (sql) => {
        const rows = await sql`
          UPDATE agent_roles SET approved_by = ${approvedBy}, granted_at = now()
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
            AND approved_by IS NULL AND revoked_at IS NULL
            AND principal_user_id <> ${approvedBy}
          RETURNING id`;
        return rows.length > 0;
      });
    },
    async restoreRevoked({ principalUserId, scope, approvedBy }) {
      return mutate(principalUserId, async (tx) => {
        if (principalUserId === approvedBy) return false;
        const rows = await tx`
          SELECT id, approved_by, revoked_at FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT 1 FOR UPDATE`;
        if (!rows[0]?.approved_by || !rows[0]?.revoked_at) return false;
        const inserted = await tx`
          INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, requested_by, created_at)
          SELECT ${principalUserId}, ${scope}, ${approvedBy}, now(), requested_by, clock_timestamp() FROM agent_roles WHERE id = ${rows[0].id}
          ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING RETURNING id`;
        return inserted.length > 0;
      });
    },
    async denyPending({ principalUserId, scope }) {
      return mutate(principalUserId, async (sql) => {
        const rows = await sql`
          UPDATE agent_roles SET revoked_at = now()
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
            AND approved_by IS NULL AND revoked_at IS NULL
          RETURNING id`;
        return rows.length > 0;
      });
    },
    async insertRole({ principalUserId, scope, approvedBy }) {
      return mutate(principalUserId, async (sql) => {
        const rows = await sql`
          INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, created_at)
          VALUES (${principalUserId}, ${scope}, ${approvedBy}, now(), clock_timestamp())
          ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
          RETURNING id`;
        return rows.length > 0;
      });
    },
    async isServicePrincipal(principalUserId) {
      const rows = await sql`SELECT 1 AS ok FROM agent_principals WHERE user_id = ${principalUserId} AND service_key IS NOT NULL LIMIT 1`;
      return rows.length > 0;
    },
    async revokeRole({ principalUserId, scope }) {
      return mutate(principalUserId, async (sql) => {
        const rows = await sql`
          UPDATE agent_roles SET revoked_at = now()
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
            AND approved_by IS NOT NULL AND revoked_at IS NULL
          RETURNING id`;
        return rows.length > 0;
      });
    },
  };
}
