// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/service-auth`
 * Purpose: A service on a home node P calls a target node X with a short-lived signed assertion (RFC 7523 shape, OAuth 2.1 resource server). X issues no
 *   key: it trusts P's published signing key, and a grant row an admin turned On decides every call.
 *   Home side: `createServiceAssertionSigner`. Target side: `createServiceAssertionVerifier`, `ensureServicePrincipal`, `findServicePrincipal`, `requestServiceAccess`.
 * Scope: Ed25519 over Web Crypto (no dependency, no node: import). The caller owns env, routes, transactions and logging. Holds no secret except the signer's
 *   own private JWK, which the caller hands in and the package never logs or returns.
 * Invariants:
 *   - ASSERTION_IS_SHORT_LIVED: `exp - iat <= 300` s; the signer uses 120 s. The verifier rejects a longer window (`malformed`) and a reused `jti` inside it (`replayed`).
 *   - TRUSTED_HOMES_ONLY: an issuer is accepted only if the target's configuration lists it, with its JWKS URI and allowed services.
 *   - FAIL_CLOSED: every refusal is a result code; an unknown `kid` refetches at most once a minute and then fails closed; a JWKS fetch failure is `jwks_unavailable`.
 *   - GRANTS_DECIDE_CALLS: a verified assertion only names the caller (issuer, service) and the scope it claims; it grants nothing. The grant row decides.
 *   - ONE_PRINCIPAL_PER_SERVICE: `ensureServicePrincipal` maps (issuer, service) to one external principal on its own users row. No credential rows.
 *   - NO_TOKEN_IN_ERRORS: no result, error or log field holds a token or a key.
 *   - DURABLE_REPLAY (0.10.0): `createPostgresReplayStore` keeps each `jti` in Postgres until `exp`, so a replay is refused after a restart and by every replica.
 *   - LINKED_ISSUERS (0.10.0): a verifier may take `resolveHome`, a run-time lookup of issuers that are not in `trustedHomes` (the node's link table). The static list wins.
 *   - SIGNED_EXTRA_CLAIMS (0.10.0): the signer and the verifier carry primitive claims under non-registered names (a link's `act`, `code`, `org`, `services`), covered by the signature.
 * Side-effects: IO (SQL in the principal helpers; the default JWKS fetch)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import type { SqlTag } from "./postgres";
import { writeExternalPrincipal } from "./principals";
import { AgentRolesError, type AskOutcome, requestAccess } from "./roles";
import type { AgentGrantsStore, ScopeKind } from "./types";

/** Longest assertion lifetime the verifier accepts, in seconds. */
export const SERVICE_ASSERTION_MAX_LIFETIME_SECONDS = 300;
/** Lifetime the signer gives each assertion, in seconds. */
const SIGNER_LIFETIME_SECONDS = 120;
/** Clock skew tolerated on `exp` and `iat`, in seconds. */
const CLOCK_SKEW_SECONDS = 30;
/** An unknown `kid` refetches the JWKS at most this often. */
export const JWKS_REFETCH_MIN_INTERVAL_MS = 60_000;
/** A cached JWKS is refetched after this age, so a withdrawn key stops working. */
export const JWKS_MAX_AGE_MS = 60 * 60_000;
const MAX_TOKEN_CHARS = 4096;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const JWKS_MAX_BYTES = 64 * 1024;

/** The service a node signs as for a link or unlink (`./org-links`). It is never a run principal: no principal row is made for it. */
export const NODE_CONNECT_SERVICE = "node-connect";

/** A service slug: lowercase, starts with a letter or digit, at most 64 characters. */
export const SERVICE_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCOPE_CLAIM = /^[A-Za-z0-9:._-]+(?: [A-Za-z0-9:._-]+)*$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface PublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly kid: string;
  readonly use: "sig";
  readonly alg: "EdDSA";
}

/** An Ed25519 private key as a JWK (`kty` OKP, `crv` Ed25519, `d` the secret, `x` the public key). */
export interface Ed25519PrivateJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly d: string;
  readonly x: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(text: string): Uint8Array | null {
  if (!B64URL.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const jsonB64Url = (value: unknown): string => toB64Url(enc.encode(JSON.stringify(value)));

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(dec.decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** True for a canonical https origin: `https://host[:port]`, nothing else. */
export function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

/** The audience claim for a node id. */
export const nodeAudience = (nodeId: string): string => `urn:cogni:node:${nodeId}`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Home side: the signer
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface ServiceAssertionRequest {
  /** The service slug (becomes `sub`), such as `git-review` or `node-ai`. */
  readonly service: string;
  /** The target node's id (becomes `aud` as `urn:cogni:node:<id>`). */
  readonly audienceNodeId: string;
  /** The permissions the call uses, space separated, such as `knowledge:read`. */
  readonly scope: string;
  /**
   * Extra signed claims (0.10.0): primitive values under names that are not registered claims. They are covered by the signature, so a replayed or edited body changes nothing.
   * A link carries `act`, `code`, `org` and `services` here. A reserved name or a non-primitive value throws `TypeError`.
   */
  readonly claims?: Readonly<Record<string, string | number | boolean>>;
}

/** Claim names the signer owns: a caller's extra claim can never replace one. */
const RESERVED_CLAIMS: ReadonlySet<string> = new Set(["iss", "sub", "aud", "client_id", "scope", "iat", "exp", "jti", "nbf", "typ"]);
const CLAIM_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_EXTRA_CLAIMS = 8;
const MAX_CLAIM_STRING = 200;

/** The extra claims a request may carry, checked, or a `TypeError`. */
function checkedExtraClaims(claims: ServiceAssertionRequest["claims"]): Record<string, string | number | boolean> {
  if (claims === undefined) return {};
  const entries = Object.entries(claims);
  if (entries.length > MAX_EXTRA_CLAIMS) throw new TypeError("too many extra claims");
  for (const [name, value] of entries) {
    if (!CLAIM_NAME.test(name) || RESERVED_CLAIMS.has(name)) throw new TypeError("extra claim name is reserved or malformed");
    const ok =
      (typeof value === "string" && value.length <= MAX_CLAIM_STRING) || (typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "boolean";
    if (!ok) throw new TypeError("extra claim must be a short string, a safe integer or a boolean");
  }
  return Object.fromEntries(entries);
}

export interface ServiceAssertionSigner {
  sign(request: ServiceAssertionRequest): Promise<string>;
  /** `Bearer <jwt>`: a fresh assertion per call. */
  authorizationHeader(request: ServiceAssertionRequest): Promise<string>;
  /** The public key set to serve at `/.well-known/jwks.json`. Never carries the private member. */
  jwks(): { keys: PublicJwk[] };
}

export function createServiceAssertionSigner(opts: {
  /** This node's canonical https origin (becomes `iss`). */
  issuer: string;
  kid: string;
  privateJwk: Ed25519PrivateJwk;
  /** Epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}): ServiceAssertionSigner {
  const { issuer, kid, privateJwk } = opts;
  if (!isCanonicalHttpsOrigin(issuer)) throw new TypeError("issuer must be a canonical https origin");
  if (!kid || /\s/.test(kid)) throw new TypeError("kid is required");
  if (privateJwk?.kty !== "OKP" || privateJwk.crv !== "Ed25519" || typeof privateJwk.d !== "string" || typeof privateJwk.x !== "string")
    throw new TypeError("privateJwk must be an Ed25519 OKP key with d and x");
  const now = opts.now ?? Date.now;
  let key: Promise<CryptoKey> | undefined;
  const signingKey = () =>
    (key ??= crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", d: privateJwk.d, x: privateJwk.x },
      { name: "Ed25519" },
      false,
      ["sign"]
    ));
  const publicJwk: PublicJwk = { kty: "OKP", crv: "Ed25519", x: privateJwk.x, kid, use: "sig", alg: "EdDSA" };

  const sign = async (request: ServiceAssertionRequest): Promise<string> => {
    if (!SERVICE_SLUG.test(request.service)) throw new TypeError("service must be a lowercase slug");
    if (!request.audienceNodeId || /\s/.test(request.audienceNodeId)) throw new TypeError("audienceNodeId is required");
    if (!SCOPE_CLAIM.test(request.scope)) throw new TypeError("scope must be space-separated permission names");
    const extra = checkedExtraClaims(request.claims);
    const iat = Math.floor(now() / 1000);
    const header = jsonB64Url({ alg: "EdDSA", kid, typ: "JWT" });
    const payload = jsonB64Url({
      ...extra,
      iss: issuer,
      sub: request.service,
      aud: nodeAudience(request.audienceNodeId),
      client_id: `${issuer}#${request.service}`,
      scope: request.scope,
      iat,
      exp: iat + SIGNER_LIFETIME_SECONDS,
      jti: crypto.randomUUID(),
    });
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, await signingKey(), enc.encode(input));
    return `${input}.${toB64Url(new Uint8Array(signature))}`;
  };

  return {
    sign,
    authorizationHeader: async (request) => `Bearer ${await sign(request)}`,
    jwks: () => ({ keys: [{ ...publicJwk }] }),
  };
}

/** PKCS#8 prefix of an Ed25519 private key (RFC 8410): the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";

/** The RFC 7638 JWK thumbprint of an Ed25519 public key (`{"crv","kty","x"}` in that member order, sha256, base64url). */
export async function ed25519Thumbprint(x: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`));
  return toB64Url(new Uint8Array(digest));
}

/**
 * A signer from a 32-byte seed (64 hex characters), the form an operator generates and stores as a secret. The Ed25519 key pair is derived through Web Crypto from the
 * PKCS#8 encoding (prefix + seed); `kid` is the RFC 7638 thumbprint of the public key, so two nodes never need to agree on a name. Throws `TypeError` for a seed
 * that is not 64 hex characters (the message never carries the value). The JWK variant (`createServiceAssertionSigner`) stays for an operator that keeps its own key.
 */
export async function createServiceAssertionSignerFromSeed(opts: {
  /** This node's canonical https origin (becomes `iss`). */
  issuer: string;
  /** 64 hex characters: the 32-byte Ed25519 seed. */
  seedHex: string;
  now?: () => number;
}): Promise<ServiceAssertionSigner> {
  if (typeof opts.seedHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(opts.seedHex)) throw new TypeError("seed must be 64 hex characters");
  const der = Uint8Array.from((ED25519_PKCS8_PREFIX + opts.seedHex).match(/../g) as string[], (byte) => Number.parseInt(byte, 16));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as { d?: string; x?: string };
  if (typeof jwk.d !== "string" || typeof jwk.x !== "string") throw new TypeError("seed could not be expanded to a key");
  return createServiceAssertionSigner({
    issuer: opts.issuer,
    kid: await ed25519Thumbprint(jwk.x),
    privateJwk: { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x },
    ...(opts.now ? { now: opts.now } : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Target side: replay store and verifier
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Remembers each `jti` until its assertion expires. */
export interface ReplayStore {
  /** True when `jti` was already seen (a replay). Otherwise records it until `expiresAt` and returns false. */
  seen(jti: string, expiresAt: Date): Promise<boolean>;
}

/**
 * In-memory replay store, bounded to the assertion window (entries leave at their expiry) and to `maxEntries`. SINGLE REPLICA ONLY: another replica has its
 * own memory, so a target with several replicas needs a shared store (Postgres) behind the same interface. At the bound the oldest entry goes first, which
 * only a trusted home that signs thousands of assertions inside one window can trigger.
 */
export function createMemoryReplayStore(opts?: { maxEntries?: number; now?: () => number }): ReplayStore {
  const maxEntries = opts?.maxEntries ?? 10_000;
  const now = opts?.now ?? Date.now;
  const entries = new Map<string, number>();
  return {
    async seen(jti, expiresAt) {
      const at = now();
      for (const [id, until] of entries) {
        if (until > at) break;
        entries.delete(id);
      }
      const until = entries.get(jti);
      if (until !== undefined && until > at) return true;
      entries.delete(jti);
      entries.set(jti, Math.max(expiresAt.getTime(), at));
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return false;
    },
  };
}

/** Rows one prune pass removes at most (the table holds only the assertion window, so this keeps a pass cheap). */
const REPLAY_PRUNE_BATCH = 200;

/**
 * DURABLE replay store over `service_assertion_jtis` (migration template `migrations/service_assertion_jtis.sql`): the `jti` is the primary key, so a replay is refused by every
 * replica and after a restart. `seen` inserts the `jti` with its expiry and answers true only when a LIVE row already holds it; an expired row that was not pruned yet is taken
 * over, not reported as a replay. Each call also prunes at most `REPLAY_PRUNE_BATCH` rows past their expiry, so the table holds one assertion window. The expiry travels as an ISO
 * string (NO_DATE_PARAMETERS). The prune takes the oldest expired rows with `FOR UPDATE SKIP LOCKED`, so concurrent calls never wait on each other. `sql` is a service-role
 * connection (the table has no policy). A store failure rejects (the node answers 503); it is never a pass.
 */
export function createPostgresReplayStore(sql: SqlTag): ReplayStore {
  return {
    async seen(jti, expiresAt) {
      const until = expiresAt.toISOString();
      const taken = await sql`
        INSERT INTO service_assertion_jtis (jti, expires_at) VALUES (${jti}, ${until}::timestamptz)
        ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at
          WHERE service_assertion_jtis.expires_at <= now()
        RETURNING jti`;
      await sql`
        DELETE FROM service_assertion_jtis
        WHERE jti IN (
          SELECT jti FROM service_assertion_jtis WHERE expires_at <= now() ORDER BY expires_at LIMIT ${REPLAY_PRUNE_BATCH} FOR UPDATE SKIP LOCKED
        )`;
      return taken.length === 0;
    },
  };
}

/** One home node the target trusts. */
export interface TrustedHome {
  /** The home's canonical https origin: must equal the assertion's `iss`. */
  readonly issuer: string;
  readonly jwksUri: string;
  /** The service slugs this home may call as. */
  readonly services: readonly string[];
}

export type ServiceAssertionRefusal =
  | "untrusted_issuer"
  | "bad_signature"
  | "wrong_audience"
  | "expired"
  | "replayed"
  | "service_not_allowed"
  | "malformed"
  | "jwks_unavailable";

/** A verified assertion: who is calling and the scope it claims. It grants nothing. */
export interface VerifiedServiceAssertion {
  readonly ok: true;
  readonly issuer: string;
  readonly service: string;
  readonly clientId: string;
  readonly scope: string;
  readonly jti: string;
  /** The signed extra claims (primitives under non-registered names), verified with the rest. Empty for an ordinary call. */
  readonly claims: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A refusal. `issuer` and `service` are present once the claims parsed, for the node's log only: they are NOT verified (the signature may be bad), so a
 * caller never decides on them.
 */
export interface ServiceAssertionRefused {
  readonly ok: false;
  readonly code: ServiceAssertionRefusal;
  readonly issuer?: string;
  readonly service?: string;
}

export type ServiceAssertionResult = VerifiedServiceAssertion | ServiceAssertionRefused;

export interface ServiceAssertionVerifier {
  verify(token: string): Promise<ServiceAssertionResult>;
}

/**
 * The claims of a token WITHOUT checking its signature, or null when it is not a three-part token with a JSON payload. Only for choosing which key to verify with (a link names the
 * origin its code is bound to); never a basis for any decision. A caller always runs the verifier on the same token before it trusts one value.
 */
export function peekUnverifiedClaims(token: string): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = fromB64Url(parts[1] as string);
  return payload ? parseJsonObject(payload) : null;
}

/**
 * The trusted homes from a parsed list (`[{ issuer, jwks_uri, services }]`, the shape of a node's `.cogni/service-links.yaml`), or `[]` when it is missing or not a list
 * (every assertion is then `untrusted_issuer`: fail closed). Strict per entry: a canonical https `issuer`, a `jwks_uri` that parses as an https URL and a `services` list are
 * required, any other entry is dropped; of the services only those matching `SERVICE_SLUG` are kept.
 */
export function parseTrustedHomes(raw: unknown): TrustedHome[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): TrustedHome[] => {
    const e = entry as { issuer?: unknown; jwks_uri?: unknown; services?: unknown } | null;
    if (!e || typeof e.issuer !== "string" || !isCanonicalHttpsOrigin(e.issuer) || typeof e.jwks_uri !== "string" || !Array.isArray(e.services)) return [];
    try {
      if (new URL(e.jwks_uri).protocol !== "https:") return [];
    } catch {
      return [];
    }
    const services = e.services.filter((s): s is string => typeof s === "string" && SERVICE_SLUG.test(s));
    return [{ issuer: e.issuer, jwksUri: e.jwks_uri, services }];
  });
}

/** One node this node's AI may call: the alias a tool names, the node id the assertion's `aud` carries, and the target's canonical https origin. */
export interface LinkTarget {
  readonly alias: string;
  readonly nodeId: string;
  readonly origin: string;
}

/** The alias a tool may name. */
export const LINK_ALIAS = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LINK_NODE_ID = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The link targets from a parsed list (`[{ alias, node_id, origin }]`, the shape of a node's `.cogni/service-links.yaml`), or `[]` when it is missing or not a list. Strict per
 * entry (a lowercase `alias`, a `node_id`, a canonical https `origin` with no credentials); any other entry is dropped, and a repeated alias keeps its first entry.
 */
export function parseLinkTargets(raw: unknown): LinkTarget[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: LinkTarget[] = [];
  for (const entry of raw) {
    const e = entry as { alias?: unknown; node_id?: unknown; origin?: unknown } | null;
    if (!e || typeof e.alias !== "string" || !LINK_ALIAS.test(e.alias) || typeof e.node_id !== "string" || !LINK_NODE_ID.test(e.node_id)) continue;
    if (typeof e.origin !== "string" || !isCanonicalHttpsOrigin(e.origin) || seen.has(e.alias)) continue;
    seen.add(e.alias);
    out.push({ alias: e.alias, nodeId: e.node_id, origin: e.origin });
  }
  return out;
}

/**
 * Proves the public `x` of a private JWK belongs to its `d`: signs a probe with the private key and verifies it with `x` alone. Throws when it does not, so a
 * node never publishes a key set that no assertion it signs can satisfy.
 */
export async function assertSigningKeyMatches(privateJwk: Ed25519PrivateJwk): Promise<void> {
  const probe = enc.encode("cogni-signing-key-self-check");
  const priv = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: privateJwk.d, x: privateJwk.x }, { name: "Ed25519" }, false, ["sign"]);
  const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: privateJwk.x }, { name: "Ed25519" }, false, ["verify"]);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, priv, probe);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, pub, signature, probe))) throw new Error("signing key: public x does not match private d");
}

/** Default JWKS fetch: https only, 5 s timeout, 64 KiB cap. */
async function defaultFetchJwks(jwksUri: string): Promise<unknown> {
  const url = new URL(jwksUri);
  if (url.protocol !== "https:") throw new Error("jwks uri must be https");
  const res = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`jwks status ${res.status}`);
  const text = await res.text();
  if (text.length > JWKS_MAX_BYTES) throw new Error("jwks too large");
  return JSON.parse(text);
}

interface JwksState {
  keys: Map<string, CryptoKey>;
  /** When the keys were last fetched successfully. */
  okAt: number | null;
  /** When a fetch was last attempted (the refetch rate limit runs from it). */
  attemptAt: number | null;
  /** True when the last attempt failed. */
  failed: boolean;
  refresh: Promise<void> | null;
}

export function createServiceAssertionVerifier(opts: {
  /** This node's id: the audience every assertion must name. */
  selfNodeId: string;
  trustedHomes: readonly TrustedHome[];
  /** Fetch and parse a JWKS document. Default: https, 5 s, 64 KiB. */
  fetchJwks?: (jwksUri: string) => Promise<unknown>;
  /**
   * Issuers that are not in `trustedHomes`, looked up at verify time (the node's open links). `trustedHomes` wins; a null answer is `untrusted_issuer`. A lookup failure rejects
   * (the node answers 503), never trusts.
   */
  resolveHome?: (issuer: string) => Promise<TrustedHome | null>;
  replay: ReplayStore;
  /** Epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}): ServiceAssertionVerifier {
  const now = opts.now ?? Date.now;
  const fetchJwks = opts.fetchJwks ?? defaultFetchJwks;
  const audience = nodeAudience(opts.selfNodeId);
  const homes = new Map(opts.trustedHomes.map((home) => [home.issuer, home]));
  const states = new Map<string, JwksState>();

  const refresh = (home: TrustedHome, state: JwksState): Promise<void> => {
    state.refresh ??= (async () => {
      state.attemptAt = now();
      try {
        const doc = await fetchJwks(home.jwksUri);
        const list = (doc as { keys?: unknown } | null)?.keys;
        if (!Array.isArray(list)) throw new Error("jwks has no keys");
        const keys = new Map<string, CryptoKey>();
        for (const raw of list) {
          const jwk = raw as Record<string, unknown> | null;
          if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.kid !== "string") continue;
          if (jwk.use !== undefined && jwk.use !== "sig") continue;
          try {
            keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]));
          } catch {
            // an unusable key is skipped; the token that names it fails closed
          }
        }
        state.keys = keys;
        state.okAt = now();
        state.failed = false;
      } catch {
        state.failed = true;
      } finally {
        state.refresh = null;
      }
    })();
    return state.refresh;
  };

  /** The verification key for `kid`, or why there is none. A key older than `JWKS_MAX_AGE_MS` is never used. */
  const keyFor = async (home: TrustedHome, kid: string): Promise<CryptoKey | "unknown_kid" | "jwks_unavailable"> => {
    let state = states.get(home.issuer);
    if (!state) states.set(home.issuer, (state = { keys: new Map(), okAt: null, attemptAt: null, failed: false, refresh: null }));
    const current = state;
    const fresh = () => current.okAt !== null && now() - current.okAt < JWKS_MAX_AGE_MS;
    const cached = current.keys.get(kid);
    if (cached && fresh()) return cached;
    // First use, an expired cache or an unknown kid: refetch, but an unknown kid refetches at most once a minute.
    if (current.refresh) await current.refresh;
    else if (current.attemptAt === null || now() - current.attemptAt >= JWKS_REFETCH_MIN_INTERVAL_MS) await refresh(home, current);
    if (current.failed || !fresh()) return "jwks_unavailable";
    return current.keys.get(kid) ?? "unknown_kid";
  };

  return {
    async verify(token) {
      let who: { issuer?: string; service?: string } = {};
      const refuse = (code: ServiceAssertionRefusal): ServiceAssertionResult => ({ ok: false, code, ...who });
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return refuse("malformed");
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
      if (header.alg !== "EdDSA" || typeof header.kid !== "string" || header.kid.length === 0) return refuse("malformed");
      if (header.typ !== undefined && header.typ !== "JWT") return refuse("malformed");

      const { iss, sub, aud, client_id: clientId, scope, iat, exp, jti } = claims;
      if (
        typeof iss !== "string" ||
        typeof sub !== "string" ||
        typeof aud !== "string" ||
        typeof clientId !== "string" ||
        typeof scope !== "string" ||
        typeof jti !== "string" ||
        jti.length === 0 ||
        jti.length > 128 ||
        typeof iat !== "number" ||
        typeof exp !== "number" ||
        !Number.isFinite(iat) ||
        !Number.isFinite(exp) ||
        !SCOPE_CLAIM.test(scope) ||
        clientId !== `${iss}#${sub}` ||
        exp <= iat ||
        exp - iat > SERVICE_ASSERTION_MAX_LIFETIME_SECONDS
      )
        return refuse("malformed");

      who = { issuer: iss.slice(0, 200), service: sub.slice(0, 100) };
      const home = homes.get(iss) ?? (opts.resolveHome ? await opts.resolveHome(iss) : null) ?? undefined;
      if (!home || home.issuer !== iss) return refuse("untrusted_issuer");

      const key = await keyFor(home, header.kid);
      if (key === "jwks_unavailable") return refuse("jwks_unavailable");
      if (key === "unknown_kid") return refuse("bad_signature");
      let valid = false;
      try {
        valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, enc.encode(`${h}.${p}`) as BufferSource);
      } catch {
        valid = false;
      }
      if (!valid) return refuse("bad_signature");

      // The claims are trustworthy from here on.
      if (!home.services.includes(sub)) return refuse("service_not_allowed");
      if (aud !== audience) return refuse("wrong_audience");
      const nowSeconds = now() / 1000;
      if (nowSeconds >= exp + CLOCK_SKEW_SECONDS) return refuse("expired");
      if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return refuse("malformed");
      // Replay is last so only a fully valid assertion can use up a `jti`. A store failure rejects (the node answers 503); it is never a pass.
      if (await opts.replay.seen(`${iss}#${jti}`, new Date((exp + CLOCK_SKEW_SECONDS) * 1000))) return refuse("replayed");
      const extra: Record<string, string | number | boolean> = {};
      for (const [name, value] of Object.entries(claims)) {
        if (RESERVED_CLAIMS.has(name)) continue;
        if (CLAIM_NAME.test(name) && (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value)))) extra[name] = value;
      }
      return { ok: true, issuer: iss, service: sub, clientId, scope, jti, claims: extra };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Target side: the service principal and its ask
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The users.id of the one principal for (issuer, service): a version-4-shaped UUID derived from sha-256 of `<issuer>#<service>`, so creation is idempotent
 * with no lookup key beyond the id and a concurrent pair converge on one row.
 */
export async function servicePrincipalId(input: { issuer: string; service: string }): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`cogni-service-principal\u0000${input.issuer}#${input.service}`)));
  const b = digest.slice(0, 16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const serviceDisplayName = (input: { issuer: string; service: string }): string => `${input.service}@${new URL(input.issuer).host}`;

/**
 * Create or find the one external principal for (issuer, service): its own `users` row and an `external` `agent_principals` row. No credential rows.
 * Idempotent and safe under concurrency (the id is derived). `tx` is a service-role connection.
 */
export async function ensureServicePrincipal(tx: SqlTag, input: { issuer: string; service: string }): Promise<string> {
  if (!isCanonicalHttpsOrigin(input.issuer) || !SERVICE_SLUG.test(input.service)) throw new TypeError("issuer and service must be canonical");
  // `node-connect` only signs links: it is never a run principal, so it never asks for a grant and never holds a payer row.
  if (input.service === NODE_CONNECT_SERVICE) throw new TypeError("node-connect is not a principal");
  const userId = await servicePrincipalId(input);
  await tx`INSERT INTO users (id, name) VALUES (${userId}, ${serviceDisplayName(input)}) ON CONFLICT (id) DO NOTHING`;
  await writeExternalPrincipal(tx, userId);
  return userId;
}

/** The principal of (issuer, service) if it has been enrolled (it has asked), else null. Reads only. */
export async function findServicePrincipal(sql: SqlTag, input: { issuer: string; service: string }): Promise<string | null> {
  const userId = await servicePrincipalId(input);
  const rows = await sql`SELECT 1 AS found FROM agent_principals WHERE user_id = ${userId} AND kind = 'external' LIMIT 1`;
  return rows.length > 0 ? userId : null;
}

/**
 * The service's ask: ensure its principal and write ONE pending ask for `scope` (the ordinary ask row; an admin turns it On in `/admin/ai-access`). Idempotent:
 * a pending ask is reported (its link rotated), a live grant is reported as granted. Nothing is granted. The asked scope must be inside the assertion's own
 * `scope` claim, so the signed assertion is what the service asked for.
 */
export async function requestServiceAccess(input: {
  tx: SqlTag;
  store: AgentGrantsStore;
  assertion: VerifiedServiceAssertion;
  scope: string;
  declaredScopes: readonly string[];
  askableScopes: readonly string[];
  scopeKinds?: Readonly<Record<string, ScopeKind>>;
  /**
   * Runs in the caller's transaction right after the principal exists: the node binds a service of a LINKED issuer to the link's org here, so a principal that appears after
   * the link is bound when it is created (`bindLinkedService` in `./org-links`).
   */
  onPrincipal?: (userId: string) => Promise<void>;
}): Promise<{ userId: string; outcome: AskOutcome }> {
  if (!input.assertion.scope.split(" ").includes(input.scope)) throw new AgentRolesError("invalid_scope", "scope is not in the signed assertion");
  const userId = await ensureServicePrincipal(input.tx, { issuer: input.assertion.issuer, service: input.assertion.service });
  if (input.onPrincipal) await input.onPrincipal(userId);
  const outcome = await requestAccess(input.store, {
    principalUserId: userId,
    scope: input.scope,
    declaredScopes: input.declaredScopes,
    askableScopes: input.askableScopes,
    ...(input.scopeKinds ? { scopeKinds: input.scopeKinds } : {}),
  });
  return { userId, outcome };
}
