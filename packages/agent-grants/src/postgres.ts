// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/postgres`
 * Purpose: The Postgres implementation of the store, over an injected tagged-template query function.
 * Scope: Raw SQL against `agent_roles`, `agent_principals`, and `billing_accounts` (an owner check only).
 *   A postgres.js `Sql` or `TransactionSql` fits `SqlTag` as is; node-plane writes require a begin-capable client or transaction-bound tag.
 *   Node-plane role mutations take the user lock before reading or changing authority, so provider maintenance coordinates with the same writer.
 * Invariants:
 *   - The package never creates a client, switches a role, or runs a schema.
 *   - NO_DATE_PARAMETERS: a timestamp is written with `now()`, SQL interval arithmetic or an ISO string, never a JS Date. The node's client is drizzle's postgres.js
 *     client, which replaces the timestamp serializers; timestamps read back as strings too (`iso()` accepts both).
 *   - RESOURCE_SPLIT (R1): every node-plane statement names `resource = 'node'`; every account statement names `resource = 'account'`.
 *     The expand-phase live index stays (principal, scope), so one open row exists per AI and scope.
 *   - ACCOUNT_LIVE (R1, R14, durable): an account row is live when approved, unrevoked and (`expires_at` is null, i.e. until Off, or in the future); expired is read, and an expired live
 *     row is closed (`revoked_at = now()`) before an ask or a direct On on the same (AI, scope), so the old index frees.
 *   - The decision statements carry the owner join themselves (`billing_accounts.owner_user_id = approver`), so a caller cannot widen them.
 *   - `agent_roles` has FORCE RLS and one narrow select policy (an account row naming the connection's own user): only a service-role
 *     connection writes it or reads the rest. `agent_principals` has a read-only select policy for every role; only a service-role
 *     connection writes it.
 * Side-effects: IO
 * @public
 */

import { lockUserAuthority } from "./authority-lock";
import { AgentRolesError } from "./roles";
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

/** `https://cognidao.org#git-review` -> `Verified service of cognidao.org`. Plain words only (TOKENLESS_COPY): no path, id or key. */
function serviceHint(serviceKey: string, homeOrigin: string | null): string | null {
  try {
    const host = new URL(homeOrigin ?? serviceKey.split("#")[0] ?? "").host;
    return host ? `Verified service of ${host}` : null;
  } catch {
    return null;
  }
}

/** An ask whose approval deadline passed, or one closed because it expired, never masks an earlier explicit control (an approval or an Off). */
const EXPIRED_ASK_CLOSE = ["enrollment_expired", "request_expired"];

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
    // A transaction-bound tag reuses its caller's transaction. A bare tag (a test double or an adapter with no transaction) runs the same statements
    // without the held lock: the node's own store always arrives through `withStore`, which opens the transaction.
    return run(sql);
  };
  const toRow = (row: Record<string, unknown>): RoleRow | null => {
    const principalUserId = str(row.principal_user_id);
    const scope = str(row.scope);
    const rowId = str(row.id);
    if (!principalUserId || !scope || !rowId) return null;
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
      state: row.approved_by
        ? row.revoked_at
          ? ("revoked" as const)
          : ("granted" as const)
        : ("pending" as const),
      at: iso(row.created_at),
      rowId,
      resource: row.resource === "account" ? "account" : "node",
      accountId: str(row.account_id),
      expiresAt: row.expires_at ? iso(row.expires_at) : null,
    };
  };
  /** Closes the live account rows of this (principal, scope) that already ended (R14), so the open-row index frees. State still reads expired. */
  const closeExpired = async (principalUserId: string, scope: string, tx: SqlTag = sql): Promise<void> => {
    await tx`
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
          AND approved_by IS NOT NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`;
      return rows.length > 0;
    },
    async liveAccountScopes(principalId, scopes, accountId) {
      if (scopes.length === 0) return [];
      const rows = await sql`
        SELECT DISTINCT scope FROM agent_roles
        WHERE principal_user_id = ${principalId} AND scope = ANY(${scopes as string[]}) AND resource = 'account' AND account_id = ${accountId}
          AND approved_by IS NOT NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
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
    async listRoleRows(limit, declaredScopes = [], after) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("role page limit must be between 1 and 100");
      // This node's own AI: always all rows (a few principals times a few scopes).
      const own = await sql`
        SELECT r.id, r.principal_user_id, r.scope, r.approved_by, r.revoked_at, r.created_at, r.resource, r.account_id, r.expires_at,
               p.slug AS slug, p.kind AS kind, u.name AS user_name,
               NULL::text AS github_id, NULL::text AS service_key, NULL::text AS home_origin
        FROM agent_roles r
        JOIN users u ON u.id = r.principal_user_id
        JOIN agent_principals p ON p.user_id = r.principal_user_id AND p.kind = 'internal'
        WHERE r.resource = 'node' AND r.revoked_at IS NULL
        ORDER BY r.created_at`;
      // Canonical current controls, then keyset and limit. Retained identity capacity is independent of the active 25 limit.
      // Latest consent is one indexed lateral read per retained principal+declared scope; no all-history DISTINCT/COUNT.
      // An enrolled service shows its latest explicit control (an approval, or an Off) or a live ask; any other outside agent shows its open rows.
      const outside = await sql`
        WITH controls AS (
          SELECT r.id, r.principal_user_id, r.scope, r.approved_by, r.revoked_at, r.created_at, r.resource, r.account_id, r.expires_at,
                 NULL::text AS slug, 'external' AS kind, u.name AS user_name, NULL::text AS github_id, p.service_key, p.home_origin
          FROM agent_principals p
          CROSS JOIN unnest(${declaredScopes as string[]}::text[]) s(scope)
          CROSS JOIN LATERAL (
            SELECT id, principal_user_id, scope, approved_by, revoked_at, created_at, request_expires_at, resource, account_id, expires_at FROM (
              (SELECT id, principal_user_id, scope, approved_by, revoked_at, created_at, request_expires_at, resource, account_id, expires_at FROM agent_roles
                WHERE principal_user_id=p.user_id AND scope=s.scope AND resource = 'node' AND (approved_by IS NOT NULL OR
                  (approved_by IS NULL AND revoked_at IS NOT NULL AND (closed_reason IS NULL OR closed_reason NOT IN ('enrollment_expired','request_expired'))))
                ORDER BY created_at DESC NULLS LAST,id DESC NULLS LAST LIMIT 1)
              UNION ALL
              (SELECT id, principal_user_id, scope, approved_by, revoked_at, created_at, request_expires_at, resource, account_id, expires_at FROM agent_roles
                WHERE principal_user_id=p.user_id AND scope=s.scope AND resource = 'node' AND approved_by IS NULL AND revoked_at IS NULL
                  AND (request_expires_at IS NULL OR request_expires_at > (SELECT clock_timestamp())) LIMIT 1)
            ) candidates ORDER BY created_at DESC NULLS LAST,id DESC NULLS LAST LIMIT 1
          ) r
          JOIN users u ON u.id = p.user_id
          WHERE p.service_key IS NOT NULL AND (r.approved_by IS NOT NULL OR
            r.revoked_at IS NULL AND (r.request_expires_at IS NULL OR r.request_expires_at > clock_timestamp()))
          UNION ALL
          SELECT r.id, r.principal_user_id, r.scope, r.approved_by, r.revoked_at, r.created_at, r.resource, r.account_id, r.expires_at,
                 NULL::text AS slug, 'external' AS kind, u.name AS user_name,
                 (SELECT b.external_id FROM user_bindings b WHERE b.user_id = r.principal_user_id AND b.provider = 'github' LIMIT 1) AS github_id,
                 NULL::text AS service_key, NULL::text AS home_origin
          FROM agent_roles r JOIN users u ON u.id = r.principal_user_id
          WHERE r.resource = 'node' AND r.revoked_at IS NULL
            AND (r.approved_by IS NOT NULL OR r.request_expires_at IS NULL OR r.request_expires_at > clock_timestamp())
            AND NOT EXISTS (
              SELECT 1 FROM agent_principals p WHERE p.user_id = r.principal_user_id AND (p.kind = 'internal' OR p.service_key IS NOT NULL)
            )
        ) SELECT * FROM controls
        WHERE (principal_user_id, scope) > (${after?.principalUserId ?? ""}, ${after?.scope ?? ""})
        ORDER BY principal_user_id, scope LIMIT ${limit + 101}`;
      const page = outside.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        outside.length > limit && last ? { principalUserId: str(last.principal_user_id) ?? "", scope: str(last.scope) ?? "" } : null;
      const rows = [...own, ...page].flatMap((row) => {
        const mapped = toRow(row);
        return mapped ? [mapped] : [];
      });
      // A bounded lookahead count (at most 101) for legacy consumers; cursor-aware consumers continue until nextCursor = null.
      return { rows, more: Math.max(0, outside.length - limit), nextCursor };
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
          AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())
        ORDER BY r.created_at DESC
        LIMIT ${limit}`;
      const total = await sql`
        SELECT count(*)::int AS n FROM agent_roles r
        WHERE r.resource = 'account' AND r.account_id = ${accountId}
          AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())`;
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
          AND NOT (approved_by IS NULL AND revoked_at IS NOT NULL AND COALESCE(closed_reason, '') IN ('enrollment_expired', 'request_expired'))
          AND NOT (approved_by IS NULL AND revoked_at IS NULL AND request_expires_at IS NOT NULL AND request_expires_at <= clock_timestamp())
        ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST
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
      // An ISO STRING, never a Date: the node hands this store `drizzle-orm`'s postgres.js client, whose timestamp serializers pass a value through unchanged, so a JS
      // Date parameter fails there (ERR_INVALID_ARG_TYPE) although a bare postgres.js client accepts it. A string works on both. (candidate-a, 11-13: every ask was a 503.)
      const linkHash = link?.hash ?? null;
      const linkEnds = link ? link.expiresAt.toISOString() : null;
      return mutate(principalUserId, async (tx) => {
        await closeExpired(principalUserId, scope, tx);
        // An ask past its approval deadline is closed before the open-row read, so a lapsed enrollment ask frees its slot.
        await tx`UPDATE agent_roles SET revoked_at = clock_timestamp(), closed_reason = 'request_expired'
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND approved_by IS NULL AND revoked_at IS NULL
            AND request_expires_at <= clock_timestamp()`;
        const open = await tx`
          SELECT id, approved_by FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND revoked_at IS NULL LIMIT 1`;
        if (open[0]) {
          if (open[0].approved_by) return "granted" as const;
          // A re-ask rotates the link: the agent always gets a working link, and the old one stops working.
          if (link)
            await tx`
              UPDATE agent_roles SET link_hash = ${linkHash}, link_expires_at = ${linkEnds}, link_consumed_at = NULL
              WHERE id = ${open[0].id as string}`;
          return "pending" as const;
        }
        const count = await tx`
          SELECT count(*)::int AS n FROM (SELECT 1 FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND approved_by IS NULL AND revoked_at IS NULL
            AND (request_expires_at IS NULL OR request_expires_at > clock_timestamp()) LIMIT ${maxPending}) pending`;
        if (Number(count[0]?.n ?? 0) >= maxPending) return "too_many" as const;
        const all = await tx`
          SELECT count(*)::int AS n FROM (SELECT 1 FROM agent_roles WHERE approved_by IS NULL AND revoked_at IS NULL
            AND (request_expires_at IS NULL OR request_expires_at > clock_timestamp()) LIMIT ${maxPendingTotal}) pending`;
        if (Number(all[0]?.n ?? 0) >= maxPendingTotal) return "node_full" as const;
        const inserted = await tx`
          INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by, resource, link_hash, link_expires_at, created_at)
          VALUES (${principalUserId}, ${scope}, NULL, ${principalUserId}, ${resource}, ${linkHash}, ${linkEnds}, clock_timestamp())
          ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING
          RETURNING id`;
        if (inserted.length > 0) return "created" as const;
        // A concurrent ask took the open slot between our read and our insert. Whatever we answer, the link we hand back must be stored: rotate it
        // onto the winner's pending row, or report that row as already live. If neither exists (it ended in between) the ask failed: say so, never
        // return a link whose hash was not written.
        const rotated = await tx`
          UPDATE agent_roles SET link_hash = COALESCE(${linkHash}, link_hash), link_expires_at = COALESCE(${linkEnds}, link_expires_at), link_consumed_at = NULL
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = ${resource}
            AND approved_by IS NULL AND revoked_at IS NULL
          RETURNING id`;
        if (rotated.length > 0) return "pending" as const;
        const live = await tx`
          SELECT 1 AS ok FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND approved_by IS NOT NULL AND revoked_at IS NULL LIMIT 1`;
        if (live.length > 0) return "granted" as const;
        throw new Error("ask_raced");
      });
    },
    async approvePending({ principalUserId, scope, approvedBy }) {
      return mutate(principalUserId, async (tx) => {
        const rows = await tx`
          UPDATE agent_roles
          SET approved_by = ${approvedBy}, granted_at = clock_timestamp(),
              link_consumed_at = CASE WHEN link_hash IS NOT NULL THEN clock_timestamp() END, link_hash = NULL
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'node'
            AND approved_by IS NULL AND revoked_at IS NULL
            AND principal_user_id <> ${approvedBy}
            AND (request_expires_at IS NULL OR request_expires_at > clock_timestamp())
          RETURNING id`;
        if (rows.length > 0) return true;
        const expired = await tx`SELECT 1 FROM (
          SELECT approved_by, request_expires_at, revoked_at, closed_reason FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'node'
          ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT 1
        ) latest WHERE approved_by IS NULL AND request_expires_at <= clock_timestamp()
          AND (revoked_at IS NULL OR closed_reason IN ('enrollment_expired', 'request_expired'))`;
        if (expired.length > 0) {
          const control = await tx`SELECT approved_by, revoked_at FROM agent_roles WHERE principal_user_id=${principalUserId} AND scope=${scope} AND resource = 'node'
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
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'node'
            AND (approved_by IS NOT NULL OR (approved_by IS NULL AND revoked_at IS NOT NULL AND (closed_reason IS NULL OR closed_reason NOT IN ('enrollment_expired','request_expired'))))
          ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT 1 FOR UPDATE`;
        if (!rows[0]?.approved_by || !rows[0]?.revoked_at) return false;
        const inserted = await tx`
          INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, requested_by, resource, created_at)
          SELECT ${principalUserId}, ${scope}, ${approvedBy}, clock_timestamp(), requested_by, 'node', clock_timestamp() FROM agent_roles WHERE id = ${rows[0].id as string}
          ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING RETURNING id`;
        return inserted.length > 0;
      });
    },
    async denyPending({ principalUserId, scope }) {
      return mutate(principalUserId, async (tx) => {
        // V2 Dismiss writes its receipt before the role, under the already-held user authority.
        // Authority-only adopters have a null current operation and need no v2 receipt columns.
        const principal = await tx`SELECT current_operation_id FROM agent_principals WHERE user_id=${principalUserId}`;
        const operation = principal[0]?.current_operation_id;
        if (typeof operation === "string")
          await tx`SELECT id FROM agent_service_enrollments WHERE operation_id=${operation}
            AND principal_user_id=${principalUserId} FOR UPDATE`;
        const rows = await tx`
          UPDATE agent_roles
          SET revoked_at = clock_timestamp(),
              link_consumed_at = CASE WHEN link_hash IS NOT NULL THEN clock_timestamp() END, link_hash = NULL
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'node'
            AND approved_by IS NULL AND revoked_at IS NULL
          RETURNING id`;
        return rows.length > 0;
      });
    },
    async insertRole({ principalUserId, scope, approvedBy }) {
      // Direct On is for this node's own AI only (R8): the INSERT itself names the internal principal, so an outside agent cannot get
      // a row this way whatever the caller does.
      return mutate(principalUserId, async (tx) => {
        const rows = await tx`
          INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, created_at)
          SELECT ${principalUserId}, ${scope}, ${approvedBy}, clock_timestamp(), 'node', clock_timestamp()
          WHERE EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = ${principalUserId} AND ap.kind = 'internal')
            AND ${principalUserId} <> ${approvedBy}
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
      return mutate(principalUserId, async (tx) => {
        const rows = await tx`
          UPDATE agent_roles SET revoked_at = clock_timestamp()
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'node'
            AND approved_by IS NOT NULL AND revoked_at IS NULL
          RETURNING id`;
        return rows.length > 0;
      });
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
    async approveAccountByLink({ linkHash, approvedBy }) {
      // ONE statement: the owner join (billing_accounts.owner_user_id = approver) is what makes the row name an account the approver owns.
      const rows = await sql`
        UPDATE agent_roles r
        SET approved_by = ${approvedBy}, granted_at = now(), account_id = b.id,
            expires_at = NULL,
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
    async insertAccountRole({ principalUserId, scope, approvedBy }) {
      await closeExpired(principalUserId, scope);
      // Direct On is for this node's own AI only (R8), on an account the approver owns.
      const rows = await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id, expires_at)
        SELECT ${principalUserId}, ${scope}, ${approvedBy}, now(), 'account', b.id, NULL
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
