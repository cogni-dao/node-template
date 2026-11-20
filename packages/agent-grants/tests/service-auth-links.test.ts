// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import type { SqlTag } from "../src";
import {
  createMemoryReplayStore,
  createPostgresReplayStore,
  createServiceAssertionSignerFromSeed,
  createServiceAssertionVerifier,
  ensureServicePrincipal,
  peekUnverifiedClaims,
  requestServiceAccess,
  servicePrincipalId,
  type VerifiedServiceAssertion,
} from "../src/service-auth";
import { memoryStore } from "./memory-store";

const ISSUER = "https://toks5.example.org";
const NODE = "node-y";
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const T0 = 1_800_000_000_000;

describe("durable replay store (DURABLE_REPLAY)", () => {
  /** A scripted tag with the table's semantics: unique jti, an expired row is taken over, a live one is a replay. */
  function jtiTag() {
    const rows = new Map<string, number>();
    let now = T0;
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("INSERT INTO service_assertion_jtis")) {
        const [jti, until] = values as [string, string];
        const held = rows.get(jti);
        if (held !== undefined && held > now) return Promise.resolve([]);
        rows.set(jti, new Date(until).getTime());
        return Promise.resolve([{ jti }]);
      }
      if (text.includes("DELETE FROM service_assertion_jtis")) {
        for (const [jti, until] of rows) if (until <= now) rows.delete(jti);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }) as unknown as SqlTag;
    return { tag, rows, advance: (ms: number) => (now += ms) };
  }

  it("refuses a replay by any caller of the same table, takes over an expired row, and prunes", async () => {
    const db = jtiTag();
    const a = createPostgresReplayStore(db.tag);
    const b = createPostgresReplayStore(db.tag); // another replica, the same table
    expect(await a.seen("iss#j1", new Date(T0 + 150_000))).toBe(false);
    expect(await b.seen("iss#j1", new Date(T0 + 150_000))).toBe(true);
    db.advance(151_000);
    expect(await b.seen("iss#j1", new Date(T0 + 400_000))).toBe(false);
    expect(db.rows.size).toBe(1);
  });

  it("a store failure rejects, so the verifier throws and the node answers 503, never a pass", async () => {
    const store = createPostgresReplayStore((async () => Promise.reject(new Error("db down"))) as unknown as SqlTag);
    await expect(store.seen("iss#j", new Date(T0))).rejects.toThrow("db down");
  });

  it("sends the expiry as an ISO string, never a Date", async () => {
    const seen: unknown[][] = [];
    const store = createPostgresReplayStore(((_s: TemplateStringsArray, ...v: unknown[]) => (seen.push(v), Promise.resolve([{ jti: "x" }]))) as unknown as SqlTag);
    await store.seen("iss#j", new Date(T0));
    expect(seen.flat().some((v) => v instanceof Date)).toBe(false);
    expect(seen.flat()).toContain(new Date(T0).toISOString());
  });
});

describe("signed extra claims", () => {
  const rig = async () => {
    const signer = await createServiceAssertionSignerFromSeed({ issuer: ISSUER, seedHex: SEED });
    const verifier = createServiceAssertionVerifier({
      selfNodeId: NODE,
      trustedHomes: [{ issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks.json`, services: ["node-ai"] }],
      fetchJwks: async () => signer.jwks(),
      replay: createMemoryReplayStore(),
    });
    return { signer, verifier };
  };
  const base = { service: "node-ai", audienceNodeId: NODE, scope: "knowledge:read" };

  it("extra claims are signed and come back verified; an ordinary call has none", async () => {
    const { signer, verifier } = await rig();
    expect(await verifier.verify(await signer.sign({ ...base, claims: { act: "link", n: 3, ok: true } }))).toMatchObject({ ok: true, claims: { act: "link", n: 3, ok: true } });
    expect(await verifier.verify(await signer.sign(base))).toMatchObject({ ok: true, claims: {} });
  });

  it("a reserved name, a nested value and a long string are refused at signing", async () => {
    const { signer } = await rig();
    await expect(signer.sign({ ...base, claims: { iss: "https://evil.example.org" } })).rejects.toThrow(TypeError);
    await expect(signer.sign({ ...base, claims: { x: { nested: 1 } as unknown as string } })).rejects.toThrow(TypeError);
    await expect(signer.sign({ ...base, claims: { x: "y".repeat(201) } })).rejects.toThrow(TypeError);
  });

  it("peekUnverifiedClaims reads a payload without trusting it and returns null for junk", async () => {
    const { signer } = await rig();
    expect(peekUnverifiedClaims(await signer.sign(base))).toMatchObject({ iss: ISSUER, sub: "node-ai" });
    for (const junk of ["", "a.b", "a.b.c.d", "x".repeat(5000)]) expect(peekUnverifiedClaims(junk), junk).toBeNull();
  });

  it("a verifier with no static home and no resolver refuses; a resolver that returns another issuer's home is refused too", async () => {
    const { signer } = await rig();
    const token = await signer.sign(base);
    const verify = (resolveHome?: (issuer: string) => Promise<{ issuer: string; jwksUri: string; services: string[] } | null>) =>
      createServiceAssertionVerifier({
        selfNodeId: NODE,
        trustedHomes: [],
        ...(resolveHome ? { resolveHome } : {}),
        fetchJwks: async () => signer.jwks(),
        replay: createMemoryReplayStore(),
      }).verify(token);
    expect(await verify()).toMatchObject({ ok: false, code: "untrusted_issuer" });
    expect(await verify(async () => ({ issuer: "https://other.example.org", jwksUri: "https://other.example.org/k", services: ["node-ai"] }))).toMatchObject({ ok: false, code: "untrusted_issuer" });
    expect(await verify(async () => ({ issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks.json`, services: ["node-ai"] }))).toMatchObject({ ok: true });
  });
});

describe("principals", () => {
  it("node-connect never becomes a principal", async () => {
    await expect(ensureServicePrincipal((async () => []) as unknown as SqlTag, { issuer: ISSUER, service: "node-connect" })).rejects.toThrow(TypeError);
  });

  it("requestServiceAccess runs the principal hook with the new principal's id, before the ask", async () => {
    const calls: string[] = [];
    const assertion = { ok: true, issuer: ISSUER, service: "node-ai", clientId: `${ISSUER}#node-ai`, scope: "knowledge:read", jti: "j", claims: {} } as VerifiedServiceAssertion;
    await requestServiceAccess({
      tx: (async () => []) as unknown as SqlTag,
      store: memoryStore({}),
      assertion,
      scope: "knowledge:read",
      declaredScopes: ["knowledge:read"],
      askableScopes: ["knowledge:read"],
      onPrincipal: async (userId) => void calls.push(userId),
    }).catch(() => undefined);
    expect(calls).toEqual([await servicePrincipalId({ issuer: ISSUER, service: "node-ai" })]);
  });
});
