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

import type { AgentGrantsStore } from "./types";

/** A postgres.js-compatible tagged template: sql`select ${x}` resolves to rows. */
export type SqlTag = (
  strings: TemplateStringsArray,
  // `any`: postgres.js types parameters as its own union; `unknown[]` would reject a real `Sql`.
  // biome-ignore lint/suspicious/noExplicitAny: structural compatibility with postgres.js
  ...values: any[]
) => PromiseLike<ReadonlyArray<Record<string, unknown>>>;

export function createPostgresAgentGrantsStore(sql: SqlTag): AgentGrantsStore {
  return {
    async hasLiveRole(principalId, scope) {
      const rows = await sql`
        SELECT 1 AS ok FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ${scope} AND revoked_at IS NULL
        LIMIT 1`;
      return rows.length > 0;
    },
    async liveScopes(principalId, scopes) {
      if (scopes.length === 0) return [];
      const rows = await sql`
        SELECT DISTINCT scope FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ANY(${scopes as string[]}) AND revoked_at IS NULL`;
      return rows.flatMap((row) => (typeof row.scope === "string" ? [row.scope] : []));
    },
    async findInternalPrincipal(slug) {
      const rows = await sql`
        SELECT user_id FROM agent_principals
        WHERE kind = 'internal' AND slug = ${slug} LIMIT 1`;
      const userId = rows[0]?.user_id;
      return typeof userId === "string" ? { userId } : null;
    },
    async listLiveRoles() {
      const rows = await sql`
        SELECT p.slug AS principal_slug, r.scope AS scope
        FROM agent_roles r
        JOIN agent_principals p ON p.user_id = r.principal_user_id AND p.kind = 'internal'
        WHERE r.revoked_at IS NULL`;
      return rows.flatMap((row) =>
        typeof row.principal_slug === "string" && typeof row.scope === "string"
          ? [{ principalSlug: row.principal_slug, scope: row.scope }]
          : []
      );
    },
    async insertRole({ principalUserId, scope, approvedBy }) {
      const rows = await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by)
        VALUES (${principalUserId}, ${scope}, ${approvedBy})
        ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`;
      return rows.length > 0;
    },
    async revokeRole({ principalUserId, scope }) {
      const rows = await sql`
        UPDATE agent_roles SET revoked_at = now()
        WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND revoked_at IS NULL
        RETURNING id`;
      return rows.length > 0;
    },
  };
}
