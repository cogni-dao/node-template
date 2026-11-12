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

import { AgentRolesError } from "./roles";
import { lockUserAuthority } from "./authority-lock";
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
function serviceHint(serviceKey: string, homeOrigin: string | null): string | null {
  try {
    return `Verified service of ${new URL(homeOrigin ?? serviceKey.split("#")[0] ?? "").host || (() => { throw new Error("missing host"); })()}`;
  } catch {
    return null;
  }
}

export function createPostgresAgentGrantsStore(sql: SqlTag): AgentGrantsStore {
  // Lock order for authority writers: user -> enrollment (provider only) -> role -> credential.
  // A root postgres client opens a transaction; a transaction-bound tag reuses its caller's transaction.
  const mutate = <T>(principalUserId: string, fn: (tx: SqlTag) => Promise<T>): Promise<T> => {
    const run = async (tx: SqlTag): Promise<T> => {
      await lockUserAuthority(tx, principalUserId);
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
    async listRoleRows(limit, declaredScopes = [], after) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("role page limit must be between1 and100");
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
          hint: serviceKey ? serviceHint(serviceKey, str(row.home_origin)) : githubId ? `GitHub id ${githubId}` : null,
          scope,
          state: row.approved_by ? (row.revoked_at ? "revoked" as const : "granted" as const) : "pending" as const,
          at: iso(row.created_at),
        };
      };
      // This node's own AI: always all rows (a few principals times a few scopes).
      const own = await sql`
        SELECT r.principal_user_id, r.scope, r.approved_by, r.revoked_at, r.created_at,
               p.slug AS slug, p.kind AS kind, u.name AS user_name,
               NULL::text AS github_id, NULL::text AS service_key, NULL::text AS home_origin
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        JOIN agent_principals p ON p.user_id = r.principal_user_id AND p.kind = 'internal'
        WHERE r.revoked_at IS NULL
        ORDER BY r.created_at`;
      // Canonical current controls, then keyset and limit. Retained identity capacity is independent of the active25 limit.
      // Latest consent is one indexed lateral read per retained principal+declared scope; no all-history DISTINCT/COUNT.
      const outside = await sql`
        WITH controls AS (
          SELECT r.principal_user_id, r.scope, r.approved_by, r.revoked_at, r.created_at,
                 NULL::text AS slug, 'external' AS kind, u.name AS user_name, NULL::text AS github_id, p.service_key, p.home_origin
          FROM agent_principals p
          CROSS JOIN unnest(${declaredScopes as string[]}::text[]) s(scope)
          CROSS JOIN LATERAL (
            SELECT principal_user_id, scope, approved_by, revoked_at, created_at, request_expires_at FROM (
              (SELECT id, principal_user_id, scope, approved_by, revoked_at, created_at, request_expires_at FROM agent_roles
                WHERE principal_user_id=p.user_id AND scope=s.scope AND (approved_by IS NOT NULL OR
                  (approved_by IS NULL AND revoked_at IS NOT NULL AND (closed_reason IS NULL OR closed_reason NOT IN ('enrollment_expired','request_expired'))))
                ORDER BY created_at DESC NULLS LAST,id DESC NULLS LAST LIMIT 1)
              UNION ALL
              (SELECT id, principal_user_id, scope, approved_by, revoked_at, created_at, request_expires_at FROM agent_roles
                WHERE principal_user_id=p.user_id AND scope=s.scope AND approved_by IS NULL AND revoked_at IS NULL
                  AND (request_expires_at IS NULL OR request_expires_at > (SELECT clock_timestamp())) LIMIT 1)
            ) candidates ORDER BY created_at DESC NULLS LAST,id DESC NULLS LAST LIMIT 1
          ) r
          JOIN users u ON u.id = p.user_id
          WHERE p.service_key IS NOT NULL AND (r.approved_by IS NOT NULL OR
            r.revoked_at IS NULL AND (r.request_expires_at IS NULL OR r.request_expires_at > clock_timestamp()))
          UNION ALL
          SELECT r.principal_user_id, r.scope, r.approved_by, r.revoked_at, r.created_at,
                 NULL::text AS slug, 'external' AS kind, u.name AS user_name,
                 (SELECT b.external_id FROM user_bindings b WHERE b.user_id = r.principal_user_id AND b.provider = 'github' LIMIT 1), NULL::text, NULL::text
          FROM agent_roles r JOIN users u ON u.id = r.principal_user_id
          WHERE r.revoked_at IS NULL AND (r.approved_by IS NOT NULL OR r.request_expires_at IS NULL OR r.request_expires_at > clock_timestamp()) AND NOT EXISTS (
            SELECT 1 FROM agent_principals p WHERE p.user_id = r.principal_user_id AND (p.kind = 'internal' OR p.service_key IS NOT NULL)
          )
        ) SELECT * FROM controls
        WHERE (principal_user_id, scope) > (${after?.principalUserId ?? ""}, ${after?.scope ?? ""})
        ORDER BY principal_user_id, scope LIMIT ${limit + 101}`;
      const page = outside.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = outside.length > limit && last ? { principalUserId: str(last.principal_user_id) ?? "", scope: str(last.scope) ?? "" } : null;
      const rows = [...own, ...page].flatMap((row) => {
        const mapped = toRow(row);
        return mapped ? [mapped] : [];
      });
      // A bounded lookahead count (at most101) for legacy consumers; cursor-aware consumers continue until nextCursor=null.
      return { rows, more: Math.max(0, outside.length - limit), nextCursor };
    },
    async listOwnRoles(principalUserId) {
      const rows = await sql`
        WITH RECURSIVE scopes(scope,n) AS (
          (SELECT scope,1 FROM agent_roles WHERE principal_user_id=${principalUserId} ORDER BY scope LIMIT 1)
          UNION ALL
          SELECT next_scope.scope,scopes.n+1 FROM scopes CROSS JOIN LATERAL (
            SELECT scope FROM agent_roles WHERE principal_user_id=${principalUserId} AND scope>scopes.scope ORDER BY scope LIMIT 1
          ) next_scope WHERE scopes.n<200
        ) SELECT r.scope,r.approved_by,r.revoked_at,r.created_at FROM scopes
        CROSS JOIN LATERAL (
          SELECT scope,approved_by,revoked_at,created_at FROM (
            (SELECT id,scope,approved_by,revoked_at,created_at FROM agent_roles WHERE principal_user_id=${principalUserId} AND scope=scopes.scope
              AND (approved_by IS NOT NULL OR (approved_by IS NULL AND revoked_at IS NOT NULL AND (closed_reason IS NULL OR closed_reason NOT IN ('enrollment_expired','request_expired'))))
              ORDER BY created_at DESC NULLS LAST,id DESC NULLS LAST LIMIT 1)
            UNION ALL
            (SELECT id,scope,approved_by,revoked_at,created_at FROM agent_roles WHERE principal_user_id=${principalUserId} AND scope=scopes.scope
              AND approved_by IS NULL AND revoked_at IS NULL AND (request_expires_at IS NULL OR request_expires_at>(SELECT clock_timestamp())) LIMIT 1)
          ) candidates ORDER BY created_at DESC NULLS LAST,id DESC NULLS LAST LIMIT 1
        ) r ORDER BY r.created_at DESC`;
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
        await sql`UPDATE agent_roles SET revoked_at = clock_timestamp(), closed_reason = 'request_expired'
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND approved_by IS NULL AND revoked_at IS NULL
            AND request_expires_at <= clock_timestamp()`;
        const open = await sql`
          SELECT approved_by FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND revoked_at IS NULL LIMIT 1`;
        if (open[0]) return open[0].approved_by ? "granted" : "pending";
        const count = await sql`
          SELECT count(*)::int AS n FROM (SELECT 1 FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND approved_by IS NULL AND revoked_at IS NULL
            AND (request_expires_at IS NULL OR request_expires_at > clock_timestamp()) LIMIT ${maxPending}) pending`;
        if (Number(count[0]?.n ?? 0) >= maxPending) return "too_many";
        const all = await sql`
          SELECT count(*)::int AS n FROM (SELECT 1 FROM agent_roles WHERE approved_by IS NULL AND revoked_at IS NULL
            AND (request_expires_at IS NULL OR request_expires_at > clock_timestamp()) LIMIT ${maxPendingTotal}) pending`;
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
          UPDATE agent_roles SET approved_by = ${approvedBy}, granted_at = clock_timestamp()
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
            AND approved_by IS NULL AND revoked_at IS NULL
            AND principal_user_id <> ${approvedBy}
            AND (request_expires_at IS NULL OR request_expires_at > clock_timestamp())
          RETURNING id`;
        if (rows.length > 0) return true;
        const expired = await sql`SELECT 1 FROM (
          SELECT approved_by, request_expires_at, revoked_at, closed_reason FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT 1
        ) latest WHERE approved_by IS NULL AND request_expires_at <= clock_timestamp()
          AND (revoked_at IS NULL OR closed_reason IN ('enrollment_expired', 'request_expired'))`;
        if (expired.length > 0) {
          const control = await sql`SELECT approved_by, revoked_at FROM agent_roles WHERE principal_user_id=${principalUserId} AND scope=${scope}
            AND (approved_by IS NOT NULL OR (approved_by IS NULL AND revoked_at IS NOT NULL AND (closed_reason IS NULL OR closed_reason NOT IN ('enrollment_expired','request_expired'))))
            ORDER BY created_at DESC NULLS LAST,id DESC NULLS LAST LIMIT 1`;
          if (control[0]?.approved_by && control[0]?.revoked_at) return false;
          throw new AgentRolesError("request_expired", "enrollment approval deadline passed");
        }
        return false;
      }).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && (error as { constraint_name?: unknown }).constraint_name === "agent_role_request_expired")
          throw new AgentRolesError("request_expired", "enrollment approval deadline passed");
        throw error;
      });
    },
    async restoreRevoked({ principalUserId, scope, approvedBy }) {
      return mutate(principalUserId, async (tx) => {
        if (principalUserId === approvedBy) return false;
        await tx`UPDATE agent_roles SET revoked_at=clock_timestamp(),closed_reason='request_expired'
          WHERE principal_user_id=${principalUserId} AND scope=${scope} AND approved_by IS NULL AND revoked_at IS NULL
            AND request_expires_at IS NOT NULL AND request_expires_at<=clock_timestamp()`;
        const rows = await tx`
          SELECT id, approved_by, revoked_at FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
            AND (approved_by IS NOT NULL OR (approved_by IS NULL AND revoked_at IS NOT NULL AND (closed_reason IS NULL OR closed_reason NOT IN ('enrollment_expired','request_expired'))))
          ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT 1 FOR UPDATE`;
        if (!rows[0]?.approved_by || !rows[0]?.revoked_at) return false;
        const inserted = await tx`
          INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, requested_by, created_at)
          SELECT ${principalUserId}, ${scope}, ${approvedBy}, clock_timestamp(), requested_by, clock_timestamp() FROM agent_roles WHERE id = ${rows[0].id}
          ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING RETURNING id`;
        return inserted.length > 0;
      });
    },
    async denyPending({ principalUserId, scope }) {
      return mutate(principalUserId, async (sql) => {
        // V2 Dismiss writes its receipt before the role, under the already-held user authority.
        // Authority-only adopters have a null current operation and need no v2 receipt columns.
        const principal = await sql`SELECT current_operation_id FROM agent_principals WHERE user_id=${principalUserId}`;
        const operation = principal[0]?.current_operation_id;
        if (typeof operation === "string")
          await sql`SELECT id FROM agent_service_enrollments WHERE operation_id=${operation}
            AND principal_user_id=${principalUserId} FOR UPDATE`;
        const rows = await sql`
          UPDATE agent_roles SET revoked_at = clock_timestamp()
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
          VALUES (${principalUserId}, ${scope}, ${approvedBy}, clock_timestamp(), clock_timestamp())
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
          UPDATE agent_roles SET revoked_at = clock_timestamp()
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
            AND approved_by IS NOT NULL AND revoked_at IS NULL
          RETURNING id`;
        return rows.length > 0;
      });
    },
  };
}
