// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/postgres`
 * Purpose: The Postgres implementation of the store, over an injected tagged-template query function.
 * Scope: Raw SQL against `agent_roles`, `agent_principals` and (one owner read) `billing_accounts`.
 *   A postgres.js `Sql` or `TransactionSql` fits `SqlTag` as is; a node adapts any other driver.
 * Invariants:
 *   - The package never creates a client, switches a role, or runs a schema.
 *   - `agent_roles` has FORCE RLS: only a service-role connection writes it, and reads every row. The app role reads only an agent's own personal rows
 *     (one select policy, for `agent_has_scope`). `agent_principals` has a read-only select policy for every role; only a service-role connection writes it.
 *   - NODE_READS_ARE_NODE_ONLY: every node read filters `resource_kind = 'node'`, so a personal row never opens a node lock and never reaches the admin table.
 *   - LIVE_PERSONAL_PREDICATE: a personal row is live when its owner approved it, it is not revoked, it has not ended (database clock), and the agent still
 *     belongs to that owner. This is the same predicate as the SQL function `agent_has_scope` (migration template), so the app check and RLS cannot disagree.
 * Side-effects: IO
 * @public
 */

import { PERSONAL_GRANT_TTL_DAYS } from "./roles";
import type { AgentGrantsStore, OwnRoleRow, PersonalRow, RoleRow } from "./types";

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

/** NAMES_ARE_IDENTIFIERS: the owner is shown by their display name; an agent with no owner row says so. */
const ownerHint = (row: Record<string, unknown>): string =>
  row.owner_user_id ? `Owner: ${str(row.owner_name)?.trim() || "Unnamed person"}` : "No owner";

export function createPostgresAgentGrantsStore(sql: SqlTag): AgentGrantsStore {
  return {
    async hasLiveRole(principalId, scope, resource) {
      if (resource && resource.kind !== "node") {
        const personal = await sql`
          SELECT 1 AS ok FROM agent_roles r
          WHERE r.principal_user_id = ${principalId} AND r.scope = ${scope}
            AND r.resource_kind = ${resource.kind} AND r.owner_user_id = ${resource.ownerUserId}
            AND r.approved_by = r.owner_user_id AND r.revoked_at IS NULL AND r.expires_at > now()
            AND EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = r.principal_user_id AND ap.owner_user_id = r.owner_user_id)
          LIMIT 1`;
        return personal.length > 0;
      }
      // LIVE_NEEDS_APPROVAL: approved_by IS NOT NULL. A pending ask never opens a lock.
      const rows = await sql`
        SELECT 1 AS ok FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ${scope}
          AND approved_by IS NOT NULL AND revoked_at IS NULL AND resource_kind = 'node'
        LIMIT 1`;
      return rows.length > 0;
    },
    async liveScopes(principalId, scopes) {
      if (scopes.length === 0) return [];
      const rows = await sql`
        SELECT DISTINCT scope FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ANY(${scopes as string[]})
          AND approved_by IS NOT NULL AND revoked_at IS NULL AND resource_kind = 'node'`;
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
        WHERE r.approved_by IS NOT NULL AND r.revoked_at IS NULL AND r.resource_kind = 'node'`;
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
        return {
          principalUserId,
          slug: internal ? str(row.slug) : null,
          internal,
          name: internal ? str(row.slug) : str(row.user_name), // NAMES_ARE_IDENTIFIERS: the slug is the name
          // The owner (the person who issued the spawn grant) or "No owner", then a proven binding, shown beside the agent's own (unproven) name.
          hint: internal ? null : [ownerHint(row), githubId ? `GitHub id ${githubId}` : null].filter(Boolean).join(" · "),
          scope,
          state: row.approved_by ? ("granted" as const) : ("pending" as const),
          at: iso(row.created_at),
        };
      };
      // This node's own AI: always all rows (a few principals times a few scopes).
      const own = await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.created_at,
               p.slug AS slug, p.kind AS kind, u.name AS user_name,
               NULL::text AS github_id
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        JOIN agent_principals p ON p.user_id = r.principal_user_id AND p.kind = 'internal'
        WHERE r.revoked_at IS NULL AND r.resource_kind = 'node'
        ORDER BY r.created_at`;
      // Outside agents: pending asks first, bounded. `more` says how many are cut.
      const outside = await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.created_at,
               NULL::text AS slug, 'external' AS kind, u.name AS user_name,
               op.owner_user_id AS owner_user_id, ou.name AS owner_name,
               (SELECT b.external_id FROM user_bindings b WHERE b.user_id = r.principal_user_id AND b.provider = 'github' LIMIT 1) AS github_id
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        LEFT JOIN agent_principals op ON op.user_id = r.principal_user_id
        LEFT JOIN users ou ON ou.id = op.owner_user_id
        WHERE r.revoked_at IS NULL AND r.resource_kind = 'node'
          AND NOT EXISTS (SELECT 1 FROM agent_principals p WHERE p.user_id = r.principal_user_id AND p.kind = 'internal')
        ORDER BY (r.approved_by IS NULL) DESC, r.created_at DESC
        LIMIT ${limit}`;
      const total = await sql`
        SELECT count(*)::int AS n FROM agent_roles r
        WHERE r.revoked_at IS NULL AND r.resource_kind = 'node'
          AND NOT EXISTS (SELECT 1 FROM agent_principals p WHERE p.user_id = r.principal_user_id AND p.kind = 'internal')`;
      const rows = [...own, ...outside].flatMap((row) => {
        const mapped = toRow(row);
        return mapped ? [mapped] : [];
      });
      return { rows, more: Math.max(0, Number(total[0]?.n ?? 0) - outside.length) };
    },
    async listOwnRoles(principalUserId) {
      const rows = await sql`
        SELECT r.scope, r.approved_by, r.revoked_at, r.created_at, r.resource_kind,
               (r.expires_at IS NOT NULL AND r.expires_at <= now()) AS ended,
               CASE WHEN r.resource_kind = 'account'
                    THEN (SELECT b.id FROM billing_accounts b WHERE b.owner_user_id = r.owner_user_id LIMIT 1) END AS account_id
        FROM agent_roles r
        WHERE r.principal_user_id = ${principalUserId}
        ORDER BY r.created_at DESC
        LIMIT 200`;
      const seen = new Set<string>();
      const out: OwnRoleRow[] = [];
      for (const row of rows) {
        const scope = str(row.scope);
        if (!scope || seen.has(scope)) continue;
        seen.add(scope);
        const approved = row.approved_by !== null && row.approved_by !== undefined;
        const revoked = row.revoked_at !== null && row.revoked_at !== undefined;
        // A personal grant past its end is over: the agent sees `revoked`, and may ask again.
        const ended = row.ended === true;
        const granted = approved && !revoked && !ended;
        const accountId = granted ? str(row.account_id) : null;
        out.push({
          scope,
          state: granted ? "granted" : approved ? "revoked" : revoked ? "denied" : "pending",
          at: iso(row.created_at),
          ...(accountId ? { accountId } : {}),
        });
      }
      return out;
    },
    async requestRole({ principalUserId, scope, maxPending, maxPendingTotal, resource }) {
      if (resource && resource.kind !== "node") {
        // A personal grant that ran out still holds the one-live-row slot: end it, so the agent can ask again.
        await sql`
          UPDATE agent_roles SET revoked_at = now()
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource_kind <> 'node'
            AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()`;
        const live = await sql`
          SELECT approved_by FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource_kind <> 'node' AND revoked_at IS NULL LIMIT 1`;
        if (live[0]) return live[0].approved_by ? "granted" : "pending";
        // A personal ask counts against this agent's cap only. It never counts toward the node-wide cap, so it cannot flood the admin.
        const mine = await sql`
          SELECT count(*)::int AS n FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND approved_by IS NULL AND revoked_at IS NULL`;
        if (Number(mine[0]?.n ?? 0) >= maxPending) return "too_many";
        const made = await sql`
          INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by, resource_kind, owner_user_id)
          VALUES (${principalUserId}, ${scope}, NULL, ${principalUserId}, ${resource.kind}, ${resource.ownerUserId})
          ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
          RETURNING id`;
        return made.length > 0 ? "created" : "pending";
      }
      const open = await sql`
        SELECT approved_by FROM agent_roles
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND revoked_at IS NULL AND resource_kind = 'node' LIMIT 1`;
      if (open[0]) return open[0].approved_by ? "granted" : "pending";
      const count = await sql`
        SELECT count(*)::int AS n FROM agent_roles
        WHERE principal_user_id = ${principalUserId} AND approved_by IS NULL AND revoked_at IS NULL AND resource_kind = 'node'`;
      if (Number(count[0]?.n ?? 0) >= maxPending) return "too_many";
      const all = await sql`
        SELECT count(*)::int AS n FROM agent_roles WHERE approved_by IS NULL AND revoked_at IS NULL AND resource_kind = 'node'`;
      if (Number(all[0]?.n ?? 0) >= maxPendingTotal) return "node_full";
      const inserted = await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by)
        VALUES (${principalUserId}, ${scope}, NULL, ${principalUserId})
        ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`;
      return inserted.length > 0 ? "created" : "pending";
    },
    async approvePending({ principalUserId, scope, approvedBy, resource, ttlDays }) {
      if (resource && resource.kind !== "node") {
        // NO_SELF_APPROVAL + APPROVER_FOLLOWS_RESOURCE: only the row's owner approves it, and never the agent itself. The row ends on the database clock.
        const days = Math.trunc(ttlDays ?? PERSONAL_GRANT_TTL_DAYS);
        const personal = await sql`
          UPDATE agent_roles SET approved_by = ${approvedBy}, granted_at = now(), expires_at = now() + (${days}::int * interval '1 day')
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
            AND approved_by IS NULL AND revoked_at IS NULL
            AND resource_kind = ${resource.kind} AND owner_user_id = ${resource.ownerUserId}
            AND owner_user_id = ${approvedBy} AND principal_user_id <> ${approvedBy}
          RETURNING id`;
        return personal.length > 0;
      }
      const rows = await sql`
        UPDATE agent_roles SET approved_by = ${approvedBy}, granted_at = now()
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          AND approved_by IS NULL AND revoked_at IS NULL AND resource_kind = 'node'
          AND principal_user_id <> ${approvedBy}
        RETURNING id`;
      return rows.length > 0;
    },
    async denyPending({ principalUserId, scope, resource }) {
      if (resource && resource.kind !== "node") {
        const personal = await sql`
          UPDATE agent_roles SET revoked_at = now()
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
            AND approved_by IS NULL AND revoked_at IS NULL
            AND resource_kind = ${resource.kind} AND owner_user_id = ${resource.ownerUserId}
          RETURNING id`;
        return personal.length > 0;
      }
      const rows = await sql`
        UPDATE agent_roles SET revoked_at = now()
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          AND approved_by IS NULL AND revoked_at IS NULL AND resource_kind = 'node'
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
    async revokeRole({ principalUserId, scope, resource }) {
      if (resource && resource.kind !== "node") {
        const personal = await sql`
          UPDATE agent_roles SET revoked_at = now()
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
            AND approved_by IS NOT NULL AND revoked_at IS NULL
            AND resource_kind = ${resource.kind} AND owner_user_id = ${resource.ownerUserId}
          RETURNING id`;
        return personal.length > 0;
      }
      const rows = await sql`
        UPDATE agent_roles SET revoked_at = now()
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          AND approved_by IS NOT NULL AND revoked_at IS NULL AND resource_kind = 'node'
        RETURNING id`;
      return rows.length > 0;
    },
    async agentOwner(principalUserId) {
      const rows = await sql`
        SELECT owner_user_id FROM agent_principals WHERE user_id = ${principalUserId} LIMIT 1`;
      return str(rows[0]?.owner_user_id);
    },
    async accountOwner(accountId) {
      const rows = await sql`SELECT owner_user_id FROM billing_accounts WHERE id = ${accountId} LIMIT 1`;
      return str(rows[0]?.owner_user_id);
    },
    async listPersonalRows(ownerUserId) {
      const rows = await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.expires_at, r.created_at, u.name AS user_name
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        JOIN agent_principals ap ON ap.user_id = r.principal_user_id AND ap.owner_user_id = r.owner_user_id
        WHERE r.owner_user_id = ${ownerUserId} AND r.resource_kind <> 'node' AND r.revoked_at IS NULL
          AND (r.approved_by IS NULL OR r.expires_at > now())
        ORDER BY r.created_at DESC
        LIMIT 200`;
      return rows.flatMap((row): PersonalRow[] => {
        const principalUserId = str(row.principal_user_id);
        const scope = str(row.scope);
        if (!principalUserId || !scope) return [];
        const granted = row.approved_by !== null && row.approved_by !== undefined;
        return [
          {
            principalUserId,
            name: str(row.user_name),
            scope,
            state: granted ? "granted" : "pending",
            expiresAt: granted ? iso(row.expires_at) : null,
            at: iso(row.created_at),
          },
        ];
      });
    },
  };
}
