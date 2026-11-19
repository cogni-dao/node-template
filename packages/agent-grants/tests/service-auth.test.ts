// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import type { SqlTag } from "../src";
import {
  assertSigningKeyMatches,
  createMemoryReplayStore,
  createPostgresReplayStore,
  createServiceAssertionSigner,
  createServiceAssertionSignerFromSeed,
  createServiceAssertionVerifier,
  ensureServicePrincipal,
  findServicePrincipal,
  JWKS_MAX_AGE_MS,
  JWKS_REFETCH_MIN_INTERVAL_MS,
  MAX_OFFER_CHARS,
  nodeAudience,
  parseLinkTargets,
  parseTrustedHomes,
  requestServiceAccess,
  servicePrincipalId,
  type TrustedHome,
  type VerifiedServiceAssertion,
} from "../src/service-auth";
import { memoryStore } from "./memory-store";

const ISSUER = "https://cognidao.org";
const NODE = "node-x";
const T0 = 1_800_000_000_000;

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { kty: "OKP"; crv: "Ed25519"; d: string; x: string };
  return { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x } as const;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

interface Rig {
  clock: { now: number };
  sign(over?: Partial<{ service: string; audienceNodeId: string; scope: string }>): Promise<string>;
  verify(token: string): ReturnType<ReturnType<typeof createServiceAssertionVerifier>["verify"]>;
  fetchJwks: ReturnType<typeof vi.fn>;
  signer: ReturnType<typeof createServiceAssertionSigner>;
  privateJwk: Awaited<ReturnType<typeof keyPair>>;
}

async function rig(opts: { homes?: TrustedHome[]; kid?: string; jwksKids?: string[] } = {}): Promise<Rig> {
  const clock = { now: T0 };
  const privateJwk = await keyPair();
  const kid = opts.kid ?? "k1";
  const signer = createServiceAssertionSigner({ issuer: ISSUER, kid, privateJwk, now: () => clock.now });
  const fetchJwks = vi.fn(async (_uri: string) => ({ keys: (opts.jwksKids ?? [kid]).map((k) => ({ ...signer.jwks().keys[0], kid: k })) }));
  const verifier = createServiceAssertionVerifier({
    selfNodeId: NODE,
    trustedHomes: opts.homes ?? [{ issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks.json`, services: ["git-review", "node-ai"] }],
    fetchJwks,
    replay: createMemoryReplayStore({ now: () => clock.now }),
    now: () => clock.now,
  });
  return {
    clock,
    privateJwk,
    signer,
    fetchJwks,
    sign: (over) => signer.sign({ service: "git-review", audienceNodeId: NODE, scope: "knowledge:read", ...over }),
    verify: (token) => verifier.verify(token),
  };
}

/** Re-sign arbitrary claims or header with the rig's key, to reach the refusals the signer itself will not produce. */
async function forge(r: Rig, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", r.privateJwk, { name: "Ed25519" }, false, ["sign"]);
  const iat = Math.floor(r.clock.now / 1000);
  const base = { iss: ISSUER, sub: "git-review", aud: nodeAudience(NODE), client_id: `${ISSUER}#git-review`, scope: "knowledge:read", iat, exp: iat + 60, jti: crypto.randomUUID() };
  const input = `${b64({ alg: "EdDSA", kid: "k1", typ: "JWT", ...header })}.${b64({ ...base, ...claims })}`;
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString("base64url")}`;
}

describe("signer and verifier", () => {
  it("round trips: the claims are the agreed shape and the verifier returns who called with what scope", async () => {
    const r = await rig();
    const token = await r.sign();
    const [h, p] = token.split(".") as [string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "EdDSA", kid: "k1", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims).toMatchObject({ iss: ISSUER, sub: "git-review", aud: "urn:cogni:node:node-x", client_id: `${ISSUER}#git-review`, scope: "knowledge:read", iat: T0 / 1000 });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
    expect(typeof claims.jti).toBe("string");
    expect(await r.verify(token)).toEqual({ ok: true, issuer: ISSUER, service: "git-review", clientId: `${ISSUER}#git-review`, scope: "knowledge:read", jti: claims.jti, claims: {} });
  });

  it("authorizationHeader is Bearer plus a fresh assertion each time; jwks carries no private member", async () => {
    const r = await rig();
    const a = await r.signer.authorizationHeader({ service: "node-ai", audienceNodeId: NODE, scope: "knowledge:read" });
    const b = await r.signer.authorizationHeader({ service: "node-ai", audienceNodeId: NODE, scope: "knowledge:read" });
    expect(a.startsWith("Bearer ")).toBe(true);
    expect(a).not.toBe(b);
    expect(JSON.stringify(r.signer.jwks())).not.toContain(r.privateJwk.d);
    expect(r.signer.jwks().keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", kid: "k1", alg: "EdDSA", use: "sig" });
  });

  it("refuses to build a signer for a non-canonical issuer or a non-Ed25519 key", async () => {
    const privateJwk = await keyPair();
    expect(() => createServiceAssertionSigner({ issuer: "http://cognidao.org", kid: "k", privateJwk })).toThrow();
    expect(() => createServiceAssertionSigner({ issuer: "https://cognidao.org/", kid: "k", privateJwk })).toThrow();
    expect(() => createServiceAssertionSigner({ issuer: ISSUER, kid: "k", privateJwk: { ...privateJwk, crv: "P-256" } as never })).toThrow();
  });

  it("untrusted_issuer", async () => {
    const r = await rig({ homes: [{ issuer: "https://other.example", jwksUri: "https://other.example/j", services: ["git-review"] }] });
    expect(await r.verify(await r.sign())).toMatchObject({ ok: false, code: "untrusted_issuer" });
    expect(r.fetchJwks).not.toHaveBeenCalled();
  });

  it("bad_signature: a tampered payload, a key the home does not publish", async () => {
    const r = await rig();
    const [h, , s] = (await r.sign()).split(".") as [string, string, string];
    const other = await r.sign({ scope: "knowledge:contribute" });
    expect(await r.verify(`${h}.${other.split(".")[1]}.${s}`)).toMatchObject({ ok: false, code: "bad_signature" });
    const stranger = createServiceAssertionSigner({ issuer: ISSUER, kid: "k1", privateJwk: await keyPair(), now: () => r.clock.now });
    expect(await r.verify(await stranger.sign({ service: "git-review", audienceNodeId: NODE, scope: "knowledge:read" }))).toMatchObject({ ok: false, code: "bad_signature" });
  });

  it("wrong_audience, expired, service_not_allowed", async () => {
    const r = await rig();
    expect(await r.verify(await r.sign({ audienceNodeId: "node-y" }))).toMatchObject({ ok: false, code: "wrong_audience" });
    expect(await r.verify(await r.sign({ service: "other-service" }))).toMatchObject({ ok: false, code: "service_not_allowed" });
    const old = await r.sign();
    r.clock.now += 120_000 + 30_000;
    expect(await r.verify(old)).toMatchObject({ ok: false, code: "expired" });
  });

  it("replayed: the same token twice is refused the second time", async () => {
    const r = await rig();
    const token = await r.sign();
    expect((await r.verify(token)).ok).toBe(true);
    expect(await r.verify(token)).toMatchObject({ ok: false, code: "replayed" });
  });

  it("malformed: not a jwt, wrong alg, missing claims, client_id mismatch, a window over 300 s", async () => {
    const r = await rig();
    for (const bad of ["", "abc", "a.b.c", "a.b", `${b64({ alg: "none" })}.${b64({})}.x`])
      expect(await r.verify(bad), bad).toMatchObject({ ok: false, code: "malformed" });
    expect(await r.verify(await forge(r, {}, { alg: "HS256" }))).toMatchObject({ ok: false, code: "malformed" });
    expect(await r.verify(await forge(r, { jti: undefined }))).toMatchObject({ ok: false, code: "malformed" });
    expect(await r.verify(await forge(r, { client_id: `${ISSUER}#node-ai` }))).toMatchObject({ ok: false, code: "malformed" });
    const iat = T0 / 1000;
    expect(await r.verify(await forge(r, { iat, exp: iat + 301 }))).toMatchObject({ ok: false, code: "malformed" });
    expect((await r.verify(await forge(r, { iat, exp: iat + 300 }))).ok).toBe(true);
  });

  it("jwks_unavailable when the home's key set cannot be fetched, and the failure is not cached as a pass", async () => {
    const r = await rig();
    r.fetchJwks.mockRejectedValueOnce(new Error("down"));
    expect(await r.verify(await r.sign())).toMatchObject({ ok: false, code: "jwks_unavailable" });
    // Inside the refetch interval the failure holds (no hammering); after it, the home recovers.
    expect(await r.verify(await r.sign())).toMatchObject({ ok: false, code: "jwks_unavailable" });
    expect(r.fetchJwks).toHaveBeenCalledTimes(1);
    r.clock.now += JWKS_REFETCH_MIN_INTERVAL_MS;
    expect((await r.verify(await r.sign())).ok).toBe(true);
  });

  it("caches the JWKS by kid, refetches an unknown kid at most once a minute, then fails closed", async () => {
    const r = await rig({ jwksKids: ["k1"] });
    expect((await r.verify(await r.sign())).ok).toBe(true);
    expect((await r.verify(await r.sign())).ok).toBe(true);
    expect(r.fetchJwks).toHaveBeenCalledTimes(1);
    // A token naming an unknown kid: signed by the same key but a kid the home does not list.
    const unknown = () => forge(r, {}, { kid: "rotated" });
    expect(await r.verify(await unknown())).toMatchObject({ ok: false, code: "bad_signature" });
    expect(r.fetchJwks).toHaveBeenCalledTimes(1); // inside the minute since the first fetch: no refetch
    r.clock.now += JWKS_REFETCH_MIN_INTERVAL_MS;
    expect(await r.verify(await unknown())).toMatchObject({ ok: false, code: "bad_signature" });
    expect(r.fetchJwks).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i++) await r.verify(await unknown());
    expect(r.fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("a rotated key is picked up by the one allowed refetch", async () => {
    const r = await rig({ jwksKids: ["k1"] });
    await r.verify(await r.sign());
    r.clock.now += JWKS_REFETCH_MIN_INTERVAL_MS;
    r.fetchJwks.mockResolvedValueOnce({ keys: [{ ...r.signer.jwks().keys[0], kid: "k2" }] });
    expect((await r.verify(await forge(r, {}, { kid: "k2" }))).ok).toBe(true);
  });

  it("never uses a cached key older than the max age: it refetches, and a failed refetch fails closed", async () => {
    const r = await rig();
    await r.verify(await r.sign());
    r.clock.now += JWKS_MAX_AGE_MS;
    r.fetchJwks.mockRejectedValueOnce(new Error("down"));
    expect(await r.verify(await r.sign())).toMatchObject({ ok: false, code: "jwks_unavailable" });
  });

  it("concurrent first calls share one JWKS fetch", async () => {
    const r = await rig();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => r.sign()));
    const results = await Promise.all(tokens.map((t) => r.verify(t)));
    expect(results.every((x) => x.ok)).toBe(true);
    expect(r.fetchJwks).toHaveBeenCalledTimes(1);
  });
});

describe("memory replay store", () => {
  it("remembers a jti until it expires, then forgets it, and stays bounded", async () => {
    const clock = { now: 1000 };
    const store = createMemoryReplayStore({ now: () => clock.now, maxEntries: 3 });
    expect(await store.seen("a", new Date(2000))).toBe(false);
    expect(await store.seen("a", new Date(2000))).toBe(true);
    clock.now = 2000;
    expect(await store.seen("a", new Date(3000))).toBe(false);
    for (const id of ["b", "c", "d", "e"]) await store.seen(id, new Date(9000));
    // "a" and "b" were the oldest and are gone; the bound holds.
    expect(await store.seen("e", new Date(9000))).toBe(true);
    expect(await store.seen("a", new Date(9000))).toBe(false);
  });
});

/** A scripted tag for the principal writes. */
function principalTag(rows: { principal: boolean }) {
  const calls: string[] = [];
  const tag = ((strings: TemplateStringsArray) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push(text.split(" ").slice(0, 3).join(" "));
    if (text.startsWith("SELECT")) return Promise.resolve(rows.principal ? [{ found: 1 }] : []);
    return Promise.resolve([]);
  }) as unknown as SqlTag;
  return { tag, calls };
}

describe("service principal", () => {
  it("has one derived uuid per (issuer, service)", async () => {
    const a = await servicePrincipalId({ issuer: ISSUER, service: "git-review" });
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await servicePrincipalId({ issuer: ISSUER, service: "git-review" })).toBe(a);
    expect(await servicePrincipalId({ issuer: ISSUER, service: "node-ai" })).not.toBe(a);
    expect(await servicePrincipalId({ issuer: "https://other.example", service: "git-review" })).not.toBe(a);
  });

  it("ensureServicePrincipal writes the user and one external principal row, idempotently, and no credential", async () => {
    const { tag, calls } = principalTag({ principal: false });
    const id = await ensureServicePrincipal(tag, { issuer: ISSUER, service: "git-review" });
    expect(id).toBe(await servicePrincipalId({ issuer: ISSUER, service: "git-review" }));
    expect(calls).toEqual(["INSERT INTO users", "INSERT INTO agent_principals"]);
    await expect(ensureServicePrincipal(tag, { issuer: "http://x", service: "git-review" })).rejects.toThrow();
  });

  it("findServicePrincipal answers null until the service has asked", async () => {
    expect(await findServicePrincipal(principalTag({ principal: false }).tag, { issuer: ISSUER, service: "git-review" })).toBeNull();
    expect(await findServicePrincipal(principalTag({ principal: true }).tag, { issuer: ISSUER, service: "git-review" })).toBe(
      await servicePrincipalId({ issuer: ISSUER, service: "git-review" })
    );
  });

  it("requestServiceAccess writes ONE pending ask for the signed scope, grants nothing, and refuses a scope outside the assertion", async () => {
    const store = memoryStore({ principals: {} });
    const assertion: VerifiedServiceAssertion = { ok: true, issuer: ISSUER, service: "git-review", clientId: `${ISSUER}#git-review`, scope: "knowledge:read", jti: "j" };
    const { tag } = principalTag({ principal: false });
    const base = { tx: tag, store, assertion, declaredScopes: ["knowledge:read", "knowledge:contribute"], askableScopes: ["knowledge:read", "knowledge:contribute"] };
    const first = await requestServiceAccess({ ...base, scope: "knowledge:read" });
    expect(first.outcome).toMatchObject({ state: "pending", created: true });
    const again = await requestServiceAccess({ ...base, scope: "knowledge:read" });
    expect(again.outcome).toMatchObject({ state: "pending", created: false });
    expect(again.userId).toBe(first.userId);
    expect(store.roles.filter((r) => r.principal === first.userId)).toHaveLength(1);
    expect(await store.hasLiveRole(first.userId, "knowledge:read")).toBe(false);
    await expect(requestServiceAccess({ ...base, scope: "knowledge:contribute" })).rejects.toMatchObject({ code: "invalid_scope" });
  });
});

describe("parseTrustedHomes", () => {
  // The shape of a node's .cogni/service-links.yaml: snake_case keys.
  const entry = { issuer: "https://cognidao.org", jwks_uri: "https://cognidao.org/.well-known/jwks.json", services: ["git-review"] };
  const good: TrustedHome = { issuer: entry.issuer, jwksUri: entry.jwks_uri, services: ["git-review"] };

  it("keeps well-formed homes and drops everything else; a missing or non-list value is none", () => {
    expect(
      parseTrustedHomes([entry, { ...entry, issuer: "http://x.io" }, { ...entry, jwks_uri: "http://x.io/j" }, { ...entry, jwks_uri: "not a url" }, { ...entry, services: "x" }, { issuer: entry.issuer, jwksUri: entry.jwks_uri, services: [] }, null])
    ).toEqual([good]);
    expect(parseTrustedHomes(undefined)).toEqual([]);
    expect(parseTrustedHomes("not a list")).toEqual([]);
    expect(parseTrustedHomes({ issuer: "x" })).toEqual([]);
  });

  it("keeps only the services that match the slug pattern", () => {
    const [home] = parseTrustedHomes([{ ...entry, services: ["git-review", "Node AI", "node-ai", 7, "", "a".repeat(65), "UPPER"] }]);
    expect(home?.services).toEqual(["git-review", "node-ai"]);
  });
});

describe("parseLinkTargets", () => {
  const entry = { alias: "toks5", node_id: "f66b260b-4633-41e2-8711-b7c1b8449cc1", origin: "https://toks5-test.cognidao.org" };

  it("keeps well-formed targets and drops everything else (fail closed)", () => {
    expect(
      parseLinkTargets([
        entry,
        { ...entry, alias: "plain", origin: "http://plain.example.org" },
        { ...entry, alias: "path", origin: "https://x.example.org/path" },
        { ...entry, alias: "cred", origin: "https://user:pw@z.example.org" },
        { ...entry, alias: "Bad Alias" },
        { ...entry, alias: "noid", node_id: "" },
        { alias: "camel", nodeId: entry.node_id, origin: entry.origin },
        { ...entry, node_id: "other", origin: "https://dup.example.org" },
        null,
      ])
    ).toEqual([{ alias: "toks5", nodeId: entry.node_id, origin: entry.origin }]);
    expect(parseLinkTargets(undefined)).toEqual([]);
    expect(parseLinkTargets({ alias: "x" })).toEqual([]);
  });
});

describe("createServiceAssertionSignerFromSeed", () => {
  // RFC 8032 section 7.1, test 1: this seed derives this public key.
  const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  const x = Buffer.from(PUBLIC, "hex").toString("base64url");

  it("derives the Ed25519 key from the seed and names it by its RFC 7638 thumbprint", async () => {
    const signer = await createServiceAssertionSignerFromSeed({ issuer: ISSUER, seedHex: SEED });
    const [key] = signer.jwks().keys;
    expect(key?.x).toBe(x);
    const thumbprint = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`))).toString("base64url");
    expect(key?.kid).toBe(thumbprint);
    expect(JSON.stringify(signer.jwks())).not.toContain(SEED);
    expect(JSON.stringify(signer.jwks())).not.toMatch(/"d"/);
    // The same seed is the same key (a restart keeps its identity); another seed is another key.
    const again = await createServiceAssertionSignerFromSeed({ issuer: ISSUER, seedHex: SEED.toUpperCase() });
    expect(again.jwks()).toEqual(signer.jwks());
    const other = await createServiceAssertionSignerFromSeed({ issuer: ISSUER, seedHex: "00".repeat(32) });
    expect(other.jwks().keys[0]?.kid).not.toBe(key?.kid);
  });

  it("signs assertions that a verifier trusting its published key accepts", async () => {
    const signer = await createServiceAssertionSignerFromSeed({ issuer: ISSUER, seedHex: SEED, now: () => T0 });
    const verifier = createServiceAssertionVerifier({
      selfNodeId: NODE,
      trustedHomes: [{ issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks.json`, services: ["node-ai"] }],
      fetchJwks: async () => signer.jwks(),
      replay: createMemoryReplayStore({ now: () => T0 }),
      now: () => T0,
    });
    const token = await signer.sign({ service: "node-ai", audienceNodeId: NODE, scope: "knowledge:read" });
    expect(await verifier.verify(token)).toMatchObject({ ok: true, issuer: ISSUER, service: "node-ai" });
  });

  it("refuses a seed that is not 64 hex characters, and the message never carries the value", async () => {
    for (const bad of ["", "abc", "zz".repeat(32), "00".repeat(31), "00".repeat(33)]) {
      const error = await createServiceAssertionSignerFromSeed({ issuer: ISSUER, seedHex: bad }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(String((error as Error).message)).not.toContain(bad || "never-empty-match");
    }
    await expect(createServiceAssertionSignerFromSeed({ issuer: "http://x.io", seedHex: SEED })).rejects.toThrow("issuer");
  });
});

describe("assertSigningKeyMatches", () => {
  it("passes for a matching pair and throws when x belongs to another key", async () => {
    const a = await keyPair();
    const b = await keyPair();
    await expect(assertSigningKeyMatches(a)).resolves.toBeUndefined();
    await expect(assertSigningKeyMatches({ ...a, x: b.x })).rejects.toThrow();
  });
});

describe("extra signed claims (connect from home)", () => {
  const connect = { act: "connect", cap: 5000, seq: 3 } as const;

  it("round trips act, cap and seq through the one verifier as verified claims", async () => {
    const r = await rig({ homes: [{ issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks.json`, services: ["node-connect"] }] });
    const token = await r.signer.sign({ service: "node-connect", audienceNodeId: NODE, scope: "connection:write", claims: connect });
    const verified = await r.verify(token);
    expect(verified).toMatchObject({ ok: true, service: "node-connect", scope: "connection:write", claims: connect });
  });

  it("an edited claim breaks the signature, so a replayed or tampered body changes nothing", async () => {
    const r = await rig({ homes: [{ issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks.json`, services: ["node-connect"] }] });
    const token = await r.signer.sign({ service: "node-connect", audienceNodeId: NODE, scope: "connection:write", claims: connect });
    const [h, p, sig] = token.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    const edited = `${h}.${b64({ ...payload, cap: 999_999 })}.${sig}`;
    expect(await r.verify(edited)).toMatchObject({ ok: false, code: "bad_signature" });
  });

  it("the signer refuses a reserved or malformed claim name and a non-primitive value", async () => {
    const r = await rig();
    for (const claims of [{ scope: "x" }, { iss: "https://evil.example" }, { jti: "j" }, { Cap: 1 }, { "a b": 1 }, { cap: 1.5 }, { cap: { n: 1 } as never }, { s: "x".repeat(201) }])
      await expect(r.signer.sign({ service: "node-connect", audienceNodeId: NODE, scope: "connection:write", claims })).rejects.toThrow(TypeError);
  });

  it("an assertion with no extra claims verifies with an empty claims record", async () => {
    const r = await rig();
    expect(await r.verify(await r.sign())).toMatchObject({ ok: true, claims: {} });
  });
});

describe("Postgres replay store", () => {
  /** A tag that behaves like the table: the jti is the primary key and a live row blocks the insert (RETURNING is then empty). */
  const table = () => {
    const rows = new Map<string, string>();
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("INSERT INTO service_assertion_jtis")) {
        const [jti, until] = values as [string, string];
        if (rows.has(jti)) return Promise.resolve([]);
        rows.set(jti, until);
        return Promise.resolve([{ jti }]);
      }
      return Promise.resolve([]);
    }) as unknown as SqlTag;
    return { rows, tag };
  };

  it("answers false for a new jti and true for a repeat, over the same table (a restart keeps the row)", async () => {
    const { tag, rows } = table();
    const exp = new Date("2026-11-18T00:05:00.000Z");
    expect(await createPostgresReplayStore(tag).seen("home#j1", exp)).toBe(false);
    // A second store over the same table is a restarted process or another replica.
    expect(await createPostgresReplayStore(tag).seen("home#j1", exp)).toBe(true);
    expect(rows.get("home#j1")).toBe("2026-11-18T00:05:00.000Z");
  });

  it("a store failure rejects, never a pass", async () => {
    const down = (() => Promise.reject(new Error("db down"))) as unknown as SqlTag;
    await expect(createPostgresReplayStore(down).seen("j", new Date())).rejects.toThrow("db down");
  });
});

describe("node_id on a trusted home and offer on a target (config labels)", () => {
  it("keeps a well-formed node_id on a trusted home and drops a malformed one without dropping the home", () => {
    const base = { issuer: "https://cognidao.org", jwks_uri: "https://cognidao.org/.well-known/jwks.json", services: ["node-connect"] };
    expect(parseTrustedHomes([{ ...base, node_id: "f66b260b-4633-41e2-8711-b7c1b8449cc1" }])).toEqual([
      { issuer: base.issuer, jwksUri: base.jwks_uri, services: ["node-connect"], nodeId: "f66b260b-4633-41e2-8711-b7c1b8449cc1" },
    ]);
    expect(parseTrustedHomes([{ ...base, node_id: "has space" }])).toEqual([{ issuer: base.issuer, jwksUri: base.jwks_uri, services: ["node-connect"] }]);
    expect(parseTrustedHomes([{ ...base, node_id: 7 }])[0]).not.toHaveProperty("nodeId");
  });

  it("keeps a bounded offer string on a target and leaves a bad one out", () => {
    const entry = { alias: "prov", node_id: "n1", origin: "https://prov.example.org" };
    expect(parseLinkTargets([{ ...entry, offer: "  Shared AI, billed to your allowance.  " }])).toEqual([
      { alias: "prov", nodeId: "n1", origin: entry.origin, offer: "Shared AI, billed to your allowance." },
    ]);
    for (const offer of ["", "   ", 7, "x".repeat(MAX_OFFER_CHARS + 1)])
      expect(parseLinkTargets([{ ...entry, offer }])).toEqual([{ alias: "prov", nodeId: "n1", origin: entry.origin }]);
  });
});
