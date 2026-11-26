// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/org-statement`
 * Purpose: The org statement (task.0181, `org-account-lifecycle`): a JWT an org's node signs and serves at `<origin>/.well-known/cogni-org`, naming its node id, origin, DAO,
 *   admins (the repo-spec approvers) and enabled services, with the repo-spec commit it was read from. Org side: `createOrgStatementIssuer`. Node side: `verifyOrgStatement` and
 *   `createOrgStatementOwnerSource`, the `org-statement` owner source.
 * Scope: Ed25519 over Web Crypto (the same key as the service assertions: `<origin>/.well-known/jwks.json`). Fetches are injected; the defaults are https only, no redirect, bounded.
 *   Pure of SQL: the node's admins-from-wallets mapping and the held version are injected.
 * Invariants:
 *   - ADMINS_FROM_THE_ORG: a node learns an org's admins only from this statement. Nothing grants `org:admin` by hand.
 *   - SHORT_LIVED: `exp - iat <= 600` s (`ORG_STATEMENT_MAX_LIFETIME_SECONDS`); the issuer uses 300. A longer window is `malformed`.
 *   - VERSION_ONLY_RISES: `version` is the BUILD's commit time in seconds (every replica of one build signs the same version, and an old replica during a rolling deploy signs a lower one). A node with no
 *     build time signs NO statement (never its issue time: mixing the two would trap the floor). A verified statement at or below the highest version this process or the database has held is refused
 *     (`stale`), unless it says exactly the facts already held (a no-op); an EQUAL version with other facts is another build's, so it is stale.
 *   - OWNERS_CACHED_AT_MOST_5_MIN: a verified statement is cached per origin for at most `ORG_STATEMENT_CACHE_MS` (and never past its own `exp`), concurrent misses share one read,
 *     a value is never served past its ttl.
 *   - LAPSE_WHEN_UNREADABLE: a failed read, a bad signature, a stale or expired statement, or a refresh that cannot be recorded throws `OwnerSourceUnavailableError`; the callers treat admin roles as lapsed (the account and
 *     its balance stay).
 *   - ORIGIN_IS_THE_KEY: the statement's `iss`, `origin` and the origin it was fetched from must be equal, so a statement cannot speak for another origin.
 *   - NO_TOKEN_IN_ERRORS: no error or result carries a token or a key.
 * Side-effects: IO (the default fetches)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle, https://node-template.cognidao.org/knowledge/org-fleet-identity
 * @public
 */

import { isCanonicalOrgOrigin, MAX_OWNER_TTL_MS, type OrgSource, OwnerSourceUnavailableError, type OwnerSource } from "./orgs";
import { fromB64Url, parseJsonObject, readTextCapped, SERVICE_SLUG, type ServiceAssertionSigner } from "./service-auth";

/** Where an org serves its statement. */
export const ORG_STATEMENT_PATH = "/.well-known/cogni-org";
/** Where an org serves its public keys. */
export const ORG_JWKS_PATH = "/.well-known/jwks.json";
/** The JWT header `typ` of an org statement. */
export const ORG_STATEMENT_TYP = "cogni-org+jwt";
/** Longest statement lifetime the verifier accepts, in seconds. */
export const ORG_STATEMENT_MAX_LIFETIME_SECONDS = 600;
/** Lifetime the issuer gives each statement, in seconds. */
const ISSUER_LIFETIME_SECONDS = 300;
/** The longest a verified statement is cached (5 minutes). */
export const ORG_STATEMENT_CACHE_MS = 300_000;
const CLOCK_SKEW_SECONDS = 30;
/** A statement's `version` may not run ahead of its own `iat` by more than this. */
const MAX_VERSION_AHEAD_SECONDS = 60;
/** How long an unreadable statement is remembered as unreadable, so a page of orgs does not refetch a dead origin once per row and per request. */
const NEGATIVE_CACHE_MS = 15_000;
const MAX_ADMINS = 100;
const MAX_SERVICES = 50;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CACHED_ORIGINS = 1024;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
const COMMIT = /^[0-9a-fA-F]{7,64}$/;

/** What the org read from its own repo-spec when it signed. */
export interface OrgStatement {
  /** The org node's canonical https origin: the key of the org account. */
  readonly origin: string;
  readonly nodeId: string;
  /** The DAO contract address, lowercase, or null when the repo-spec names none. */
  readonly dao: string | null;
  /** The repo-spec approvers, lowercase, de-duplicated, sorted. */
  readonly admins: readonly string[];
  /** The services the org enables (slugs). */
  readonly services: readonly string[];
  /** The signing build's commit time in seconds: only rises with a newer build. */
  readonly version: number;
  /** The repo-spec commit the statement was read from, or null when unknown. */
  readonly commit: string | null;
  readonly iat: number;
  readonly exp: number;
}

/** The facts the org's node supplies at signing time (read from its repo-spec). */
export interface OrgFacts {
  readonly dao: string | null;
  readonly admins: readonly string[];
  readonly services: readonly string[];
  readonly commit: string | null;
}

/** A fingerprint of the facts a statement carries (not its version or times). */
const factsKey = (s: OrgStatement): string => JSON.stringify([s.dao, [...s.admins], [...s.services], s.commit]);

const lowerWallets = (list: readonly string[]): string[] => [...new Set(list.map((w) => w.toLowerCase()))].sort();

/**
 * The org's side: `statement()` returns a freshly signed statement JWT (serve it at `ORG_STATEMENT_PATH`). `facts` is read on every call so an approver removed from the
 * repo-spec is gone from the next statement. Throws `TypeError` for a facts value the verifier would refuse (a bad wallet, a bad slug), so a node never serves an unusable statement.
 */
export function createOrgStatementIssuer(opts: {
  signer: Pick<ServiceAssertionSigner, "signClaims">;
  /** This node's canonical https origin. */
  origin: string;
  nodeId: string;
  facts: () => Promise<OrgFacts> | OrgFacts;
  /**
   * The statement `version`: the running build's commit time in epoch seconds. REQUIRED: facts are constant per build, so every replica of one build shares it, and a replica of an older build (a rolling
   * deploy) signs a lower one that readers refuse as stale. `iat` and `exp` are the freshness window.
   */
  version: number;
  /** Epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}): { statement(): Promise<string> } {
  if (!isCanonicalOrgOrigin(opts.origin)) throw new TypeError("origin must be a canonical https origin");
  if (!opts.nodeId || /\s/.test(opts.nodeId)) throw new TypeError("nodeId is required");
  if (!Number.isSafeInteger(opts.version) || opts.version < 1) throw new TypeError("version must be a positive integer (epoch seconds)");
  const now = opts.now ?? Date.now;
  return {
    async statement() {
      const facts = await opts.facts();
      const admins = lowerWallets(facts.admins);
      if (admins.length === 0 || admins.length > MAX_ADMINS || admins.some((w) => !WALLET.test(w))) throw new TypeError("admins must be 1 to 100 wallet addresses");
      const services = [...new Set(facts.services)].sort();
      if (services.length > MAX_SERVICES || services.some((s) => !SERVICE_SLUG.test(s))) throw new TypeError("services must be slugs");
      if (facts.dao !== null && !WALLET.test(facts.dao)) throw new TypeError("dao must be an address or null");
      if (facts.commit !== null && !COMMIT.test(facts.commit)) throw new TypeError("commit must be a hex commit id or null");
      const iat = Math.floor(now() / 1000);
      return opts.signer.signClaims(
        {
          iss: opts.origin,
          sub: opts.nodeId,
          origin: opts.origin,
          dao: facts.dao?.toLowerCase() ?? null,
          admins,
          services,
          version: opts.version,
          commit: facts.commit,
          iat,
          exp: iat + ISSUER_LIFETIME_SECONDS,
        },
        ORG_STATEMENT_TYP
      );
    },
  };
}

export type OrgStatementRefusal = "unreachable" | "malformed" | "bad_signature" | "expired" | "wrong_origin";

export type OrgStatementResult = { readonly ok: true; readonly statement: OrgStatement } | { readonly ok: false; readonly code: OrgStatementRefusal };

/** Reads the JWKS and the statement for an origin. Injected so a test needs no network; default `fetchOrgDocument`. */
export interface OrgFetch {
  /** The body of `https://<origin><path>` as text. Throws on any failure. */
  (origin: string, path: string): Promise<string>;
}

/** The org document fetch: https, the canonical origin, no redirect, 5 s, a body of at most 64 KiB read in a stream (never `res.text()` on an unbounded body). The caller gates WHICH origin (the fleet directory). */
export const fetchOrgDocument: OrgFetch = async (origin, path) => {
  if (!isCanonicalOrgOrigin(origin)) throw new Error("origin not fetchable");
  const res = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error", headers: { accept: "application/json, text/plain" } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`status ${res.status}`);
  }
  return readTextCapped(res, MAX_BODY_BYTES);
};

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Fetch and verify the statement of `origin`: the signature against the key at the origin's own JWKS, then every claim. Never throws; a refusal is a code. `now` is epoch ms.
 */
export async function verifyOrgStatement(input: { origin: string; fetch?: OrgFetch; now?: () => number }): Promise<OrgStatementResult> {
  const { origin } = input;
  const refuse = (code: OrgStatementRefusal): OrgStatementResult => ({ ok: false, code });
  if (!isCanonicalOrgOrigin(origin)) return refuse("malformed");
  const get = input.fetch ?? fetchOrgDocument;
  const now = input.now ?? Date.now;
  let token: string;
  let jwksText: string;
  try {
    [token, jwksText] = await Promise.all([get(origin, ORG_STATEMENT_PATH), get(origin, ORG_JWKS_PATH)]);
  } catch {
    return refuse("unreachable");
  }
  token = token.trim();
  const parts = token.split(".");
  if (parts.length !== 3) return refuse("malformed");
  const [h, p, s] = parts as [string, string, string];
  const headerBytes = fromB64Url(h);
  const payloadBytes = fromB64Url(p);
  const signature = fromB64Url(s);
  if (!headerBytes || !payloadBytes || !signature) return refuse("malformed");
  const header = parseJsonObject(headerBytes);
  const claims = parseJsonObject(payloadBytes);
  if (!header || !claims) return refuse("malformed");
  if (header.alg !== "EdDSA" || header.typ !== ORG_STATEMENT_TYP || typeof header.kid !== "string" || header.kid.length === 0) return refuse("malformed");

  let jwk: Record<string, unknown> | undefined;
  try {
    const keys = (JSON.parse(jwksText) as { keys?: unknown }).keys;
    jwk = Array.isArray(keys) ? (keys as Record<string, unknown>[]).find((k) => k && k.kid === header.kid && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string" && (k.use === undefined || k.use === "sig")) : undefined;
  } catch {
    return refuse("unreachable");
  }
  if (!jwk) return refuse("bad_signature");
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x as string }, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, new TextEncoder().encode(`${h}.${p}`) as BufferSource);
  } catch {
    valid = false;
  }
  if (!valid) return refuse("bad_signature");

  // The claims are the org's own from here on; each is still checked for shape.
  const { iss, sub, origin: claimedOrigin, dao, admins, services, version, commit, iat, exp } = claims;
  if (typeof iss !== "string" || typeof sub !== "string" || typeof claimedOrigin !== "string" || sub.length === 0 || sub.length > 100) return refuse("malformed");
  if (iss !== origin || claimedOrigin !== origin) return refuse("wrong_origin");
  if (!isInt(iat) || !isInt(exp) || !isInt(version) || exp <= iat || exp - iat > ORG_STATEMENT_MAX_LIFETIME_SECONDS) return refuse("malformed");
  // VERSION_IS_A_TIME: a version far ahead of its own issue time would pin the floor above every honest statement (a build's commit time is never ahead of now).
  if (version > iat + MAX_VERSION_AHEAD_SECONDS) return refuse("malformed");
  if (!Array.isArray(admins) || admins.length === 0 || admins.length > MAX_ADMINS || admins.some((w) => typeof w !== "string" || !WALLET.test(w))) return refuse("malformed");
  if (!Array.isArray(services) || services.length > MAX_SERVICES || services.some((v) => typeof v !== "string" || !SERVICE_SLUG.test(v))) return refuse("malformed");
  if (dao !== null && (typeof dao !== "string" || !WALLET.test(dao))) return refuse("malformed");
  if (commit !== null && (typeof commit !== "string" || !COMMIT.test(commit))) return refuse("malformed");
  const nowSeconds = now() / 1000;
  if (nowSeconds >= exp + CLOCK_SKEW_SECONDS) return refuse("expired");
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return refuse("malformed");
  return {
    ok: true,
    statement: {
      origin,
      nodeId: sub,
      dao: typeof dao === "string" ? dao.toLowerCase() : null,
      admins: lowerWallets(admins as string[]),
      services: [...new Set(services as string[])].sort(),
      version,
      commit: typeof commit === "string" ? commit : null,
      iat,
      exp,
    },
  };
}

/** The `org-statement` owner source, with the statement itself for the callers that need services and the version. */
export interface OrgStatementOwnerSource extends OwnerSource {
  /** The verified statement of `origin` (cached at most 5 minutes). Throws `OwnerSourceUnavailableError` (`unreachable`, `bad_signature`, `expired`, `malformed`, `wrong_origin`, `stale`). */
  statement(origin: string): Promise<OrgStatement>;
}

export interface OrgStatementOwnerSourceDeps {
  /** The principal user ids that bound these LOWERCASED wallets: read on every `owners` call, so a person who signs in is an admin at once. */
  usersForWallets(lowercasedWallets: string[]): Promise<string[]>;
  /** The highest statement version this node has stored for the origin (the org account row), or null. A statement below it is `stale`. */
  heldVersion?: (origin: string) => Promise<number | null>;
  /** Whether the node already holds exactly this statement's facts. A statement at or below the floor that says what is held is a no-op, not `stale`; one with other facts is `stale`. */
  holdsFacts?: (statement: OrgStatement) => Promise<boolean>;
  /** Called with each newly verified statement (not a cache hit) so the node records admin and service changes in the history. If it throws, the read FAILS CLOSED (`record_failed`): an admin list is never served without its `org.admins_changed` row. */
  onVerified?: (statement: OrgStatement) => Promise<void>;
  /** How long an unreadable statement is remembered as unreadable, in ms (default 15 s; 0 = never). */
  negativeTtlMs?: number;
  /** Called with the failure of `onVerified` so the node logs it (never the statement). */
  onRefreshError?: (error: unknown) => void;
  fetch?: OrgFetch;
  /** Cache lifetime in ms: 0 to `ORG_STATEMENT_CACHE_MS` (default the maximum). 0 = no cache and no single-flight. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * The `org-statement` owner source. Owners are the users that bound a wallet the statement lists. One statement per origin is cached for at most `ttlMs` and never past its
 * own `exp`; a statement whose version is below the highest this process or the database holds is refused (`stale`), so an older build's statement cannot take admin back, UNLESS it says exactly
 * the facts already held (`holdsFacts`): that is a no-op.
 */
export function createOrgStatementOwnerSource(deps: OrgStatementOwnerSourceDeps): OrgStatementOwnerSource {
  const ttlMs = deps.ttlMs ?? ORG_STATEMENT_CACHE_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > Math.min(ORG_STATEMENT_CACHE_MS, MAX_OWNER_TTL_MS)) throw new RangeError(`ttlMs must be between 0 and ${ORG_STATEMENT_CACHE_MS}`);
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { statement: OrgStatement; until: number }>();
  const inflight = new Map<string, Promise<OrgStatement>>();
  /** The highest statement this process accepted per origin: its version and a fingerprint of its facts. */
  const highest = new Map<string, { version: number; key: string }>();
  const failed = new Map<string, { error: OwnerSourceUnavailableError; until: number }>();
  const negativeMs = ttlMs === 0 ? 0 : (deps.negativeTtlMs ?? NEGATIVE_CACHE_MS);

  const read = async (origin: string): Promise<OrgStatement> => {
    const result = await verifyOrgStatement({ origin, ...(deps.fetch ? { fetch: deps.fetch } : {}), now });
    if (!result.ok) throw new OwnerSourceUnavailableError(result.code);
    const { statement } = result;
    const seen = highest.get(origin);
    const key = factsKey(statement);
    let floor = seen?.version ?? 0;
    try {
      floor = Math.max(floor, (await deps.heldVersion?.(origin)) ?? 0);
    } catch (error) {
      throw new OwnerSourceUnavailableError("version unreadable", error);
    }
    if (statement.version <= floor) {
      // At or below the floor: accepted only when it says exactly the facts already held. An equal version with other facts is another build's (facts are constant per build), so it is stale.
      let same = seen !== undefined && seen.version === floor && seen.key === key;
      if (!same && deps.holdsFacts) {
        try {
          same = await deps.holdsFacts(statement);
        } catch (error) {
          throw new OwnerSourceUnavailableError("version unreadable", error);
        }
      }
      if (!same) throw new OwnerSourceUnavailableError("stale");
    }
    // A newly read admin list takes effect ONLY together with its history row: if recording it fails, the read fails closed (admin roles lapse) and the failure is reported.
    if (deps.onVerified) {
      try {
        await deps.onVerified(statement);
      } catch (error) {
        // A refusal the callback chose itself (`stale`: an older statement than the one held) is the answer; anything else is a failure to record, reported and failed closed.
        if (error instanceof OwnerSourceUnavailableError) throw error;
        deps.onRefreshError?.(error);
        throw new OwnerSourceUnavailableError("record_failed", error);
      }
    }
    if (statement.version > (highest.get(origin)?.version ?? 0)) highest.set(origin, { version: statement.version, key });
    return statement;
  };

  const statementOf = async (origin: string): Promise<OrgStatement> => {
    if (!isCanonicalOrgOrigin(origin)) throw new OwnerSourceUnavailableError("origin is not canonical");
    if (ttlMs === 0) return read(origin);
    const bad = failed.get(origin);
    if (bad && now() < bad.until) throw bad.error;
    const hit = cache.get(origin);
    if (hit && now() < hit.until) return hit.statement;
    const shared = inflight.get(origin);
    if (shared) return shared;
    const startedAt = now();
    const pending = read(origin)
      .then((statement) => {
        if (cache.size >= MAX_CACHED_ORIGINS && !cache.has(origin)) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.delete(origin);
        failed.delete(origin);
        // Never past the statement's own expiry, never past the ttl measured from when the read started.
        cache.set(origin, { statement, until: Math.min(startedAt + ttlMs, statement.exp * 1000) });
        return statement;
      })
      .catch((error: unknown) => {
        if (negativeMs > 0 && error instanceof OwnerSourceUnavailableError) failed.set(origin, { error, until: startedAt + negativeMs });
        throw error;
      })
      .finally(() => {
        inflight.delete(origin);
      });
    inflight.set(origin, pending);
    return pending;
  };

  return {
    kind: "org-statement",
    statement: statementOf,
    async owners(source: OrgSource) {
      if (source.kind !== "org-statement") throw new OwnerSourceUnavailableError("source kind is not org-statement");
      const statement = await statementOf(source.ref);
      try {
        return [...new Set(await deps.usersForWallets([...statement.admins]))];
      } catch (error) {
        throw new OwnerSourceUnavailableError("owner read failed", error);
      }
    },
  };
}
