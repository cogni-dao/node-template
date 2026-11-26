// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/orgs`
 * Purpose: An org is a principal of kind `org` that owns one ordinary billing account; an OWNER SOURCE decides who owns it. The one source is `grants` (0.10.0): the owners of an
 *   org are the people holding a live `org:owner` grant on its account, and the source's key (`owner_source_ref`) is the org's own `users` id. `canApprove` and `authorizeAccount`
 *   ask the owner source when an account's owner is an org.
 * Scope: Raw SQL over an injected tag (the caller owns the connection). No routes. Creating an org and its people is `./org-accounts`.
 * Invariants:
 *   - OWNERS_READ_AT_DECISION: owners are read from the grant rows when a decision is made, never cached and never copied into a second table. A failed read throws
 *     `OwnerSourceUnavailableError` (fail closed).
 *   - NO_REPO_SPEC_SOURCE (0.10.0): the GitHub repo-spec owner source and `ensureOrg` are gone. A second trust root, and the decision on the wrong side.
 *   - ORG_ACCOUNT_IS_ORDINARY: the org's `users` row owns one ordinary `billing_accounts` row with its default virtual key (the `cogni_system` pattern). `billing_accounts` is never
 *     polymorphic; there is no orgs table and no account scope.
 *   - ONE_ORG_PER_SOURCE: a unique partial index on (owner_source_kind, owner_source_ref) where kind = 'org'; the ref is the org's own id, so it is unique by construction.
 * Side-effects: IO (SQL)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import type { SqlTag } from "./postgres";
import { ORG_OWNER } from "./rights";

/** Where an org's owners come from: the holders of `org:owner` on the org's account. `ref` is the org's own `users` id. */
export type OrgSource = { kind: "grants"; ref: string };

/** The one owner source kind. */
export const GRANTS_SOURCE_KIND = "grants";

/** Reads the owners of an org as principal user ids. A failed read throws `OwnerSourceUnavailableError`, never an empty list that could be mistaken for an answer. */
export interface OwnerSource {
  readonly kind: string;
  owners(source: OrgSource): Promise<readonly string[]>;
}

/** An owner read failed or the source does not apply. Callers refuse (fail closed). */
export class OwnerSourceUnavailableError extends Error {
  readonly cause?: unknown;
  readonly reason: string;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.reason = message;
    this.name = "OwnerSourceUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** The slice of the owner sources the approval gate reads. */
export interface OrgOwners {
  owners(source: OrgSource): Promise<readonly string[]>;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The org source a stored (kind, ref) pair names. Null for an unknown kind or an empty ref. */
export function orgSourceFromKey(kind: string | null, key: string | null): OrgSource | null {
  if (kind !== GRANTS_SOURCE_KIND || !key || key.length > 100) return null;
  return { kind: GRANTS_SOURCE_KIND, ref: key };
}

/**
 * The `grants` owner source: the people holding a live `org:owner` grant on the account of the org `source.ref`. One read per call over the injected tag; a failed read throws
 * `OwnerSourceUnavailableError`. An org with no live owner returns an empty list (an org always keeps one: ONE_OWNER_MINIMUM).
 */
export function createGrantsOwnerSource(sql: SqlTag): OwnerSource {
  return {
    kind: GRANTS_SOURCE_KIND,
    async owners(source) {
      if (source.kind !== GRANTS_SOURCE_KIND) throw new OwnerSourceUnavailableError("source kind is not grants");
      try {
        const rows = await sql`
          SELECT DISTINCT r.principal_user_id
          FROM billing_accounts b
          JOIN agent_roles r ON r.account_id = b.id AND r.resource = 'account' AND r.scope = ${ORG_OWNER}
          WHERE b.owner_user_id = ${source.ref}
            AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())
          LIMIT 200`;
        return rows.flatMap((row) => {
          const id = str(row.principal_user_id);
          return id ? [id] : [];
        });
      } catch (error) {
        throw new OwnerSourceUnavailableError("owner read failed", error);
      }
    },
  };
}

/** Dispatches `owners(source)` by `source.kind`. A kind with no registered source is `OwnerSourceUnavailableError`. */
export function createOwnerSources(sources: readonly OwnerSource[]): { owners(source: OrgSource): Promise<readonly string[]> } {
  const byKind = new Map(sources.map((s) => [s.kind, s]));
  return {
    async owners(source) {
      const found = byKind.get(source.kind);
      if (!found) throw new OwnerSourceUnavailableError("no owner source for this kind");
      return found.owners(source);
    },
  };
}

/** The owner source of an org user, or null when the user is not an org. */
export async function readOrgSource(sql: SqlTag, userId: string): Promise<OrgSource | null> {
  const rows = await sql`
    SELECT owner_source_kind, owner_source_ref FROM agent_principals
    WHERE user_id = ${userId} AND kind = 'org' LIMIT 1`;
  return orgSourceFromKey(str(rows[0]?.owner_source_kind), str(rows[0]?.owner_source_ref));
}
