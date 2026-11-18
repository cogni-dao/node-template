// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/orgs`
 * Purpose: An org is a principal of kind `org` that owns one ordinary billing account; an OWNER SOURCE decides who owns it.
 *   `createRepoSpecOwnerSource` reads `activity_ledger.approvers` from the org's repo-spec on its default branch; `ensureOrg` writes the org
 *   (idempotent, keyed by owner source); `canApprove` and `authorizeAccount` ask the owner source when an account's owner is an org.
 * Scope: Raw SQL over an injected tag (the caller owns the transaction and the service-role connection) plus an injected fetch and parser. No routes.
 * Invariants:
 *   - OWNERS_READ_AT_DECISION: owners are read when a decision is made and cached inside the source for at most `ttlMs` (<= 5 minutes). The cache holds the
 *     FINAL user-id list per ref (the repo-spec read AND the wallet mapping), concurrent misses share one read, a failed read throws
 *     `OwnerSourceUnavailableError` (fail closed), and a value is never served past its ttl. Nothing is snapshotted into the database.
 *   - STEWARD_IS_NOT_AN_OWNER: only `activity_ledger.approvers` count; the steward wallet is a payout wallet.
 *   - ONE_ORG_PER_SOURCE: a unique partial index on (owner_source_kind, owner_source_ref) where kind = 'org'; `ensureOrg` serializes on that key.
 *   - ORG_ACCOUNT_IS_ORDINARY: the org's `users` row owns one ordinary `billing_accounts` row with its default virtual key (the `cogni_system` pattern).
 *     `billing_accounts` is never polymorphic; there is no orgs table and no account scope.
 * Side-effects: IO (SQL, injected fetch)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import type { SqlTag } from "./postgres";

/** Where an org's owners come from. `ref` is the repo's canonical https GitHub URL; the default branch is read. */
export type OrgSource = { kind: "repo-spec"; ref: string };

/** Reads the owners of an org as principal user ids. A failed read throws `OwnerSourceUnavailableError`, never an empty list. */
export interface OwnerSource {
  readonly kind: string;
  owners(source: OrgSource): Promise<readonly string[]>;
}

/** An owner read failed or the source does not apply. Callers refuse (fail closed). `reason` is the message: `no_approvers` for a repo-spec that lists none. */
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

/** The source is not a canonical repo reference. */
export class InvalidOrgSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrgSourceError";
  }
}

/** The longest an owner list may be cached (5 minutes). */
export const MAX_OWNER_TTL_MS = 300_000;

/** Distinct refs the cache holds at most; the oldest entry goes first. */
const MAX_CACHED_REFS = 1024;

const REPO_REF = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/**
 * The canonical form of a repo-spec ref: `https://github.com/<owner>/<repo>`, lowercase (GitHub names are case-insensitive), no `.git`, no trailing
 * slash, no query. Null when `ref` is anything else.
 */
export function canonicalRepoRef(ref: string): string | null {
  const m = REPO_REF.exec(ref);
  if (!m) return null;
  const owner = m[1] as string;
  const repo = m[2] as string;
  if (repo === "." || repo === ".." || repo.endsWith(".git")) return null;
  return `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export interface RepoSpecOwnerSourceDeps {
  /** The repo-spec yaml on the repo's default branch. May throw. */
  fetchRepoSpec(ref: string): Promise<string>;
  /** `activity_ledger.approvers` of the yaml, as EVM wallet addresses. May throw on an unparseable file. */
  extractApprovers(yaml: string): string[];
  /** The principal user ids that bound these LOWERCASED wallets. */
  usersForWallets(lowercasedWallets: string[]): Promise<string[]>;
  /** Cache lifetime in ms: 0 to `MAX_OWNER_TTL_MS` (default `MAX_OWNER_TTL_MS`). */
  ttlMs?: number;
  /** Epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}

/**
 * The `repo-spec` owner source: owners are the principals that bound a wallet listed in `activity_ledger.approvers`. The one cache of the final user-id
 * list lives here, so a caller that decides on every request calls `owners()` freely.
 */
export function createRepoSpecOwnerSource(deps: RepoSpecOwnerSourceDeps): OwnerSource {
  const ttlMs = deps.ttlMs ?? MAX_OWNER_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > MAX_OWNER_TTL_MS)
    throw new RangeError(`ttlMs must be between 0 and ${MAX_OWNER_TTL_MS}`);
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { owners: readonly string[]; expiresAt: number }>();
  const inflight = new Map<string, Promise<readonly string[]>>();

  const read = async (ref: string): Promise<readonly string[]> => {
    try {
      const approvers = deps.extractApprovers(await deps.fetchRepoSpec(ref));
      const wallets = [...new Set(approvers.map((wallet) => wallet.toLowerCase()))];
      // A repo-spec that lists no approvers has no owners to read: refuse (never an empty list that could read as "no one may", or be mistaken for an answer).
      if (wallets.length === 0) throw new OwnerSourceUnavailableError("no_approvers");
      return [...new Set(await deps.usersForWallets(wallets))];
    } catch (error) {
      if (error instanceof OwnerSourceUnavailableError) throw error;
      throw new OwnerSourceUnavailableError("owner read failed", error);
    }
  };

  return {
    kind: "repo-spec",
    async owners(source) {
      if (source.kind !== "repo-spec") throw new OwnerSourceUnavailableError("source kind is not repo-spec");
      const ref = canonicalRepoRef(source.ref);
      if (!ref) throw new OwnerSourceUnavailableError("source ref is not a canonical repo url");
      // ttlMs 0 is no cache at all: every call reads fresh, concurrent calls included (a sync job needs the live list).
      if (ttlMs === 0) return read(ref);
      const hit = cache.get(ref);
      if (hit && now() < hit.expiresAt) return hit.owners;
      const shared = inflight.get(ref);
      if (shared) return shared;
      const startedAt = now();
      // One read per ref at a time: N concurrent misses share this promise. The ttl runs from when the read started, never from when it ended.
      const pending = read(ref)
        .then((owners) => {
          if (ttlMs > 0) {
            if (cache.size >= MAX_CACHED_REFS && !cache.has(ref)) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            cache.delete(ref);
            cache.set(ref, { owners, expiresAt: startedAt + ttlMs });
          }
          return owners;
        })
        .finally(() => {
          inflight.delete(ref);
        });
      inflight.set(ref, pending);
      return pending;
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

/** The slice of the owner sources the approval gate reads. */
export interface OrgOwners {
  owners(source: OrgSource): Promise<readonly string[]>;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Create the org for `source`, or find it. Idempotent and keyed by (owner_source_kind, owner_source_ref): the org's `users` row, its `agent_principals`
 * row of kind `org` (with the two source columns) and ONE ordinary billing account owned by that user. `tx` must be a service-role TRANSACTION: the key is
 * serialized with a transaction advisory lock, so two callers cannot create two orgs. Grants nothing.
 */
export async function ensureOrg(tx: SqlTag, source: OrgSource): Promise<{ userId: string; billingAccountId: string }> {
  if (source.kind !== "repo-spec") throw new InvalidOrgSourceError("unknown owner source kind");
  const ref = canonicalRepoRef(source.ref);
  if (!ref) throw new InvalidOrgSourceError("ref must be a canonical https github repo url");
  const lockKey = `org:${source.kind}:${ref}`;
  await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  const found = await tx`
    SELECT user_id FROM agent_principals
    WHERE kind = 'org' AND owner_source_kind = ${source.kind} AND owner_source_ref = ${ref} LIMIT 1`;
  let userId = str(found[0]?.user_id);
  if (!userId) {
    userId = crypto.randomUUID();
    await tx`INSERT INTO users (id, name) VALUES (${userId}, ${`org:${ref.slice("https://github.com/".length)}`})`;
    await tx`
      INSERT INTO agent_principals (kind, user_id, owner_source_kind, owner_source_ref)
      VALUES ('org', ${userId}, ${source.kind}, ${ref})`;
  }
  const account = await tx`SELECT id FROM billing_accounts WHERE owner_user_id = ${userId} LIMIT 1`;
  let billingAccountId = str(account[0]?.id);
  if (!billingAccountId) {
    billingAccountId = crypto.randomUUID();
    await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${billingAccountId}, ${userId}, 0)`;
    await tx`INSERT INTO virtual_keys (billing_account_id, label, is_default, active) VALUES (${billingAccountId}, 'Default', true, true)`;
  }
  return { userId, billingAccountId };
}

/** The owner source of an org user, or null when the user is not an org. */
export async function readOrgSource(sql: SqlTag, userId: string): Promise<OrgSource | null> {
  const rows = await sql`
    SELECT owner_source_kind, owner_source_ref FROM agent_principals
    WHERE user_id = ${userId} AND kind = 'org' LIMIT 1`;
  const kind = str(rows[0]?.owner_source_kind);
  const ref = str(rows[0]?.owner_source_ref);
  return kind === "repo-spec" && ref ? { kind, ref } : null;
}
