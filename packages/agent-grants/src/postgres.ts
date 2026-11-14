// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/postgres`
 * Purpose: The Postgres implementation of the store, over an injected tagged-template query function.
 * Scope: Raw SQL against `agent_roles`, `agent_principals`, and `billing_accounts` (an owner check only).
 *   A postgres.js `Sql` or `TransactionSql` fits `SqlTag` as is; a node adapts any other driver.
 * Invariants:
 *   - The package never creates a client, switches a role, or runs a schema.
 *   - RESOURCE_SPLIT (R1): every node-plane statement names `resource = 'node'`; every account statement names `resource = 'account'`.
 *     The expand-phase live index stays (principal, scope), so one open row exists per AI and scope.
 *   - ACCOUNT_LIVE (R1, R14): an account row is live when approved, unrevoked and `expires_at > now()`; expired is read, and an expired live
 *     row is closed (`revoked_at = now()`) before an ask or a direct On on the same (AI, scope), so the old index frees.
 *   - The decision statements carry the owner join themselves (`billing_accounts.owner_user_id = approver`), so a caller cannot widen them.
 *   - `agent_roles` has FORCE RLS and one narrow select policy (an account row naming the connection's own user): only a service-role
 *     connection writes it or reads the rest. `agent_principals` has a read-only select policy for every role; only a service-role
 *     connection writes it.
 * Side-effects: IO
 * @public
 */

import type { AgentGrantsStore, PendingAskView, RoleRow, RoleState } from "./types";

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
  const toRow = (row: Record<string, unknown>): RoleRow | null => {
    const principalUserId = str(row.principal_user_id);
    const scope = str(row.scope);
    const rowId = str(row.id);
    if (!principalUserId || !scope || !rowId) return null;
    const internal = row.kind === "internal";
    const githubId = str(row.github_id);
    return {
      principalUserId,
      slug: internal ? str(row.slug) : null,
      internal,
      name: internal ? str(row.slug) : str(row.user_name), // NAMES_ARE_IDENTIFIERS: the slug is the name
      // A proven binding, shown beside the agent's own (unproven) name.
      hint: githubId ? `GitHub id ${githubId}` : null,
      scope,
      state: row.approved_by ? ("granted" as const) : ("pending" as const),
      at: iso(row.created_at),
      rowId,
      resource: row.resource === "account" ? "account" : "node",
      accountId: str(row.account_id),
      expiresAt: row.expires_at ? iso(row.expires_at) : null,
    };
  };
  /** Closes the live account rows of this (principal, scope) that already ended (R14), so the open-row index frees. State still reads expired. */
  const closeExpired = async (principalUserId: string, scope: string): Promise<void> => {
    await sql`
      UPDATE agent_roles SET revoked_at = now()
      WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'account'
        AND approved_by IS NOT NULL AND revoked_at IS NULL AND expires_at <= now()`;
  };
  return {
    async hasLiveRole(principalId, scope) {
      // LIVE_NEEDS_APPROVAL: approved_by IS NOT NULL. A pending ask never opens a lock. Node rows only.
      const rows = await sql`
        SELECT 1 AS ok FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ${scope} AND resource = 'node'
          AND approved_by IS NOT NULL AND revoked_at IS NULL
        LIMIT 1`;
      return rows.length > 0;
    },
    async liveScopes(principalId, scopes) {
      if (scopes.length === 0) return [];
      const rows = await sql`
        SELECT DISTINCT scope FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ANY(${scopes as string[]}) AND resource = 'node'
          AND approved_by IS NOT NULL AND revoked_at IS NULL`;
      return rows.flatMap((row) => (typeof row.scope === "string" ? [row.scope] : []));
    },
    async hasLiveAccountGrant(principalId, scope, accountId) {
      // The same test as the SQL function agent_has_scope (migration), so the app check and RLS cannot disagree.
      const rows = await sql`
        SELECT 1 AS ok FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ${scope} AND resource = 'account' AND account_id = ${accountId}
          AND approved_by IS NOT NULL AND revoked_at IS NULL AND expires_at > now()
        LIMIT 1`;
      return rows.length > 0;
    },
    async liveAccountScopes(principalId, scopes, accountId) {
      if (scopes.length === 0) return [];
      const rows = await sql`
        SELECT DISTINCT scope FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ANY(${scopes as string[]}) AND resource = 'account' AND account_id = ${accountId}
          AND approved_by IS NOT NULL AND revoked_at IS NULL AND expires_at > now()`;
      return rows.flatMap((row) => (typeof row.scope === "string" ? [row.scope] : []));
    },
    async ownsAccount(userId, accountId) {
      const rows = await sql`
        SELECT 1 AS ok FROM billing_accounts WHERE id = ${accountId} AND owner_user_id = ${userId} LIMIT 1`;
      return rows.length > 0;
    },
    async accountOf(userId) {
      const rows = await sql`SELECT id FROM billing_accounts WHERE owner_user_id = ${userId} LIMIT 1`;
      return str(rows[0]?.id);
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
        WHERE r.resource = 'node' AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL`;
      return rows.flatMap((row) =>
        typeof row.principal_slug === "string" && typeof row.scope === "string"
          ? [{ principalSlug: row.principal_slug, scope: row.scope }]
          : []
      );
    },
    async listRoleRows(limit) {
      // This node's own AI: always all rows (a few principals times a few scopes).
      const own = await sql`
        SELECT r.id, r.principal_user_id, r.scope, r.approved_by, r.created_at, r.resource, r.account_id, r.expires_at,
               p.slug AS slug, p.kind AS kind, u.name AS user_name,
               NULL::text AS github_id
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        JOIN agent_principals p ON p.user_id = r.principal_user_id AND p.kind = 'internal'
        WHERE r.resource = 'node' AND r.revoked_at IS NULL
        ORDER BY r.created_at`;
      // Outside agents: pending asks first, bounded. `more` says how many are cut.
      const outside = await sql`
        SELECT r.id, r.principal_user_id, r.scope, r.approved_by, r.created_at, r.resource, r.account_id, r.expires_at,
               NULL::text AS slug, 'external' AS kind, u.name AS user_name,
               (SELECT b.external_id FROM user_bindings b WHERE b.user_id = r.principal_user_id AND b.provider = 'github' LIMIT 1) AS github_id
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        WHERE r.resource = 'node' AND r.revoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM agent_principals p WHERE p.user_id = r.principal_user_id AND p.kind = 'internal')
        ORDER BY (r.approved_by IS NULL) DESC, r.created_at DESC
        LIMIT ${limit}`;
      const total = await sql`
        SELECT count(*)::int AS n FROM agent_roles r
        WHERE r.resource = 'node' AND r.revoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM agent_principals p WHERE p.user_id = r.principal_user_id AND p.kind = 'internal')`;
      const rows = [...own, ...outside].flatMap((row) => {
        const mapped = toRow(row);
        return mapped ? [mapped] : [];
      });
      return { rows, more: Math.max(0, Number(total[0]?.n ?? 0) - outside.length) };
    },
    async listAccountRoleRows(accountId, limit) {
      const rows = await sql`
        SELECT r.id, r.principal_user_id, r.scope, r.approved_by, r.created_at, r.resource, r.account_id, r.expires_at,
               p.slug AS slug, CASE WHEN p.kind = 'internal' THEN 'internal' ELSE 'external' END AS kind, u.name AS user_name,
               (SELECT b.external_id FROM user_bindings b WHERE b.user_id = r.principal_user_id AND b.provider = 'github' LIMIT 1) AS github_id
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        LEFT JOIN agent_principals p ON p.user_id = r.principal_user_id
        WHERE r.resource = 'account' AND r.account_id = ${accountId}
          AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL AND r.expires_at > now()
        ORDER BY r.created_at DESC
        LIMIT ${limit}`;
      const total = await sql`
        SELECT count(*)::int AS n FROM agent_roles r
        WHERE r.resource = 'account' AND r.account_id = ${accountId}
          AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL AND r.expires_at > now()`;
      const listed = rows.flatMap((row) => {
        const mapped = toRow(row);
        return mapped ? [mapped] : [];
      });
      return { rows: listed, more: Math.max(0, Number(total[0]?.n ?? 0) - rows.length) };
    },
    async listOwnRoles(principalUserId) {
      const rows = await sql`
        SELECT scope, approved_by, revoked_at, created_at, account_id,
               (expires_at IS NOT NULL AND expires_at <= COALESCE(revoked_at, now())) AS expired
        FROM agent_roles
        WHERE principal_user_id = ${principalUserId}
        ORDER BY created_at DESC
        LIMIT 200`;
      const seen = new Set<string>();
      const out: Array<{ scope: string; state: RoleState; at: string; accountId: string | null }> = [];
      for (const row of rows) {
        const scope = str(row.scope);
        const accountId = str(row.account_id);
        const key = `${scope}\u0000${accountId ?? ""}`;
        if (!scope || seen.has(key)) continue;
        seen.add(key);
        const approved = row.approved_by !== null && row.approved_by !== undefined;
        const revoked = row.revoked_at !== null && row.revoked_at !== undefined;
        // R14: expired is a state read from expires_at, never a write.
        const state: RoleState = approved
          ? row.expired === true
            ? "expired"
            : revoked
              ? "revoked"
              : "granted"
          : revoked
            ? "denied"
            : "pending";
        out.push({ scope, state, at: iso(row.created_at), accountId });
      }
      return out;
    },
    async requestRole({ principalUserId, scope, resource, link, maxPending, maxPendingTotal }) {
      await closeExpired(principalUserId, scope);
      const open = await sql`
        SELECT id, approved_by FROM agent_roles
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND revoked_at IS NULL LIMIT 1`;
      if (open[0]) {
        if (open[0].approved_by) return "granted";
        // A re-ask rotates the link: the agent always gets a working link, and the old one stops working.
        await sql`
          UPDATE agent_roles SET link_hash = ${link.hash}, link_expires_at = ${link.expiresAt}, link_consumed_at = NULL
          WHERE id = ${open[0].id as string}`;
        return "pending";
      }
      const count = await sql`
        SELECT count(*)::int AS n FROM agent_roles
        WHERE principal_user_id = ${principalUserId} AND approved_by IS NULL AND revoked_at IS NULL`;
      if (Number(count[0]?.n ?? 0) >= maxPending) return "too_many";
      const all = await sql`
        SELECT count(*)::int AS n FROM agent_roles WHERE approved_by IS NULL AND revoked_at IS NULL`;
      if (Number(all[0]?.n ?? 0) >= maxPendingTotal) return "node_full";
      const inserted = await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by, resource, link_hash, link_expires_at)
        VALUES (${principalUserId}, ${scope}, NULL, ${principalUserId}, ${resource}, ${link.hash}, ${link.expiresAt})
        ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`;
      if (inserted.length > 0) return "created";
      // A concurrent ask took the open slot between our read and our insert. Whatever we answer, the link we hand back must be stored: rotate it
      // onto the winner's pending row, or report that row as already live. If neither exists (it ended in between) the ask failed: say so, never
      // return a link whose hash was not written.
      const rotated = await sql`
        UPDATE agent_roles SET link_hash = ${link.hash}, link_expires_at = ${link.expiresAt}, link_consumed_at = NULL
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = ${resource}
          AND approved_by IS NULL AND revoked_at IS NULL
        RETURNING id`;
      if (rotated.length > 0) return "pending";
      const live = await sql`
        SELECT 1 AS ok FROM agent_roles
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND approved_by IS NOT NULL AND revoked_at IS NULL LIMIT 1`;
      if (live.length > 0) return "granted";
      throw new Error("ask_raced");
    },
    async approvePending({ principalUserId, scope, approvedBy }) {
      const rows = await sql`
        UPDATE agent_roles
        SET approved_by = ${approvedBy}, granted_at = now(),
            link_consumed_at = CASE WHEN link_hash IS NOT NULL THEN now() END, link_hash = NULL
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'node'
          AND approved_by IS NULL AND revoked_at IS NULL
          AND principal_user_id <> ${approvedBy}
        RETURNING id`;
      return rows.length > 0;
    },
    async denyPending({ principalUserId, scope }) {
      const rows = await sql`
        UPDATE agent_roles
        SET revoked_at = now(),
            link_consumed_at = CASE WHEN link_hash IS NOT NULL THEN now() END, link_hash = NULL
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'node'
          AND approved_by IS NULL AND revoked_at IS NULL
        RETURNING id`;
      return rows.length > 0;
    },
    async insertRole({ principalUserId, scope, approvedBy }) {
      // Direct On is for this node's own AI only (R8): the INSERT itself names the internal principal, so an outside agent cannot get
      // a row this way whatever the caller does.
      const rows = await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource)
        SELECT ${principalUserId}, ${scope}, ${approvedBy}, now(), 'node'
        WHERE EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = ${principalUserId} AND ap.kind = 'internal')
          AND ${principalUserId} <> ${approvedBy}
        ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`;
      return rows.length > 0;
    },
    async revokeRole({ principalUserId, scope }) {
      const rows = await sql`
        UPDATE agent_roles SET revoked_at = now()
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'node'
          AND approved_by IS NOT NULL AND revoked_at IS NULL
        RETURNING id`;
      return rows.length > 0;
    },
    async findPendingByLink({ linkHash, resource }) {
      const rows = await sql`
        SELECT r.principal_user_id, r.scope, r.resource, r.created_at,
               p.slug AS slug, p.kind AS kind, u.name AS user_name,
               (SELECT b.external_id FROM user_bindings b WHERE b.user_id = r.principal_user_id AND b.provider = 'github' LIMIT 1) AS github_id
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        LEFT JOIN agent_principals p ON p.user_id = r.principal_user_id
        WHERE r.link_hash = ${linkHash} AND r.resource = ${resource}
          AND r.approved_by IS NULL AND r.revoked_at IS NULL
          AND r.link_consumed_at IS NULL AND r.link_expires_at > now()
        LIMIT 1`;
      const row = rows[0];
      const principalUserId = str(row?.principal_user_id);
      const scope = str(row?.scope);
      if (!row || !principalUserId || !scope) return null;
      const internal = row.kind === "internal";
      const githubId = str(row.github_id);
      const view: PendingAskView = {
        principalUserId,
        slug: internal ? str(row.slug) : null,
        internal,
        name: internal ? str(row.slug) : str(row.user_name),
        hint: githubId ? `GitHub id ${githubId}` : null,
        scope,
        resource: row.resource === "account" ? "account" : "node",
        at: iso(row.created_at),
      };
      return view;
    },
    async approveAccountByLink({ linkHash, approvedBy, days }) {
      // ONE statement: the owner join (billing_accounts.owner_user_id = approver) is what makes the row name an account the approver owns.
      const rows = await sql`
        UPDATE agent_roles r
        SET approved_by = ${approvedBy}, granted_at = now(), account_id = b.id,
            expires_at = now() + ${days}::int * interval '1 day',
            link_consumed_at = now(), link_hash = NULL
        FROM billing_accounts b
        WHERE r.link_hash = ${linkHash} AND r.resource = 'account'
          AND r.approved_by IS NULL AND r.revoked_at IS NULL
          AND r.link_consumed_at IS NULL AND r.link_expires_at > now()
          AND b.owner_user_id = ${approvedBy} AND r.principal_user_id <> ${approvedBy}
        RETURNING r.id`;
      return rows.length > 0;
    },
    async denyAccountByLink({ linkHash, deniedBy }) {
      const rows = await sql`
        UPDATE agent_roles r
        SET revoked_at = now(), link_consumed_at = now(), link_hash = NULL
        WHERE r.link_hash = ${linkHash} AND r.resource = 'account'
          AND r.approved_by IS NULL AND r.revoked_at IS NULL
          AND r.link_consumed_at IS NULL AND r.link_expires_at > now()
          AND r.principal_user_id <> ${deniedBy}
          AND EXISTS (SELECT 1 FROM billing_accounts b WHERE b.owner_user_id = ${deniedBy})
        RETURNING r.id`;
      return rows.length > 0;
    },
    async insertAccountRole({ principalUserId, scope, approvedBy, days }) {
      await closeExpired(principalUserId, scope);
      // Direct On is for this node's own AI only (R8), on an account the approver owns.
      const rows = await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id, expires_at)
        SELECT ${principalUserId}, ${scope}, ${approvedBy}, now(), 'account', b.id, now() + ${days}::int * interval '1 day'
        FROM billing_accounts b
        WHERE b.owner_user_id = ${approvedBy}
          AND ${principalUserId} <> ${approvedBy}
          AND EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = ${principalUserId} AND ap.kind = 'internal')
        ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`;
      return rows.length > 0;
    },
    async revokeAccountRole({ rowId, ownerUserId }) {
      const rows = await sql`
        UPDATE agent_roles r SET revoked_at = now()
        FROM billing_accounts b
        WHERE r.id = ${rowId} AND r.resource = 'account' AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL
          AND b.id = r.account_id AND b.owner_user_id = ${ownerUserId}
        RETURNING r.id`;
      return rows.length > 0;
    },
  };
}
