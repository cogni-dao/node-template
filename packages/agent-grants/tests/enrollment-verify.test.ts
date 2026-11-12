// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Enrollment token verification and sealing (story.0038): trusted homes only, EdDSA only, exact audience, typ and kind, short life,
 * a public cnf key, home limits on service and scope, and a key sealed to cnf that only the private key opens.
 */

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createEnrollmentTokenVerifier,
  type EnrollmentIntent,
  intentDigestOf,
  openSealed,
  ENROLLMENT_PROTOCOL as SERVICE_ENROLLMENT_KIND,
  SERVICE_ENROLLMENT_TYP,
  sealToJwk,
  serviceEnrollmentAudience,
  serviceKeyOf,
  servicePrincipalName,
  type TrustedHome,
} from "../src/enrollment";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const ISSUER = "https://home.example";
const HOME_ID = "11111111-1111-4111-8111-111111111111";
const RECEIVER = {
  nodeId: NODE_ID,
  environment: "candidate-a",
  origin: "https://target.example",
};
const HOME: TrustedHome = {
  nodeId: HOME_ID,
  environment: "production",
  kids: ["k1"],
  origin: ISSUER,
  services: { "git-review": ["knowledge:read"] },
};
const NOW = new Date("2026-11-11T12:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

let signer: Awaited<ReturnType<typeof generateKeyPair>>;
let otherSigner: Awaited<ReturnType<typeof generateKeyPair>>;
let cnfPublic: JWK;
let cnfPrivate: JWK;

beforeAll(async () => {
  signer = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  otherSigner = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const cnf = await generateKeyPair("ECDH-ES", {
    crv: "X25519",
    extractable: true,
  });
  cnfPublic = await exportJWK(cnf.publicKey);
  cnfPrivate = await exportJWK(cnf.privateKey);
});

const verifier = async (homes: readonly TrustedHome[] = [HOME]) => {
  const jwk = {
    ...(await exportJWK(signer.publicKey)),
    alg: "EdDSA",
    kid: "k1",
  };
  const keys = createLocalJWKSet({ keys: [jwk] });
  return createEnrollmentTokenVerifier({
    nodeId: NODE_ID,
    receiver: RECEIVER,
    homes,
    keysFor: () => keys,
    now: () => NOW,
  });
};

const claims = (over: Record<string, unknown> = {}) => ({
  kind: SERVICE_ENROLLMENT_KIND,
  op: "start",
  operationId: "55555555-5555-4555-8555-555555555555",
  generation: 1,
  expectedGeneration: 0,
  expectedOperationId: null,
  home: { nodeId: HOME_ID, environment: "production", origin: ISSUER },
  target: RECEIVER,
  originalStartJti: "33333333-3333-4333-8333-333333333333",
  originalStartIat: nowSec,
  originalStartExp: nowSec + 300,
  jti: "33333333-3333-4333-8333-333333333333",
  service: "git-review",
  scopes: ["knowledge:read"],
  cnf: { jwk: { kty: "OKP", crv: "X25519", x: cnfPublic.x } },
  ...over,
});

async function sign(
  over: {
    payload?: Record<string, unknown>;
    typ?: string | null;
    iss?: string;
    aud?: string;
    iat?: number;
    exp?: number;
    key?: CryptoKey;
    alg?: string;
  } = {}
) {
  const header: Record<string, unknown> = {
    alg: over.alg ?? "EdDSA",
    kid: "k1",
  };
  if (over.typ !== null) header.typ = over.typ ?? SERVICE_ENROLLMENT_TYP;
  const payload = {
    ...claims(over.payload),
    originalStartIat: over.iat ?? nowSec,
    originalStartExp: over.exp ?? nowSec + 300,
  };
  return new SignJWT({
    ...payload,
    intentDigest: await intentDigestOf(payload as unknown as EnrollmentIntent),
  } as never)
    .setProtectedHeader(header as never)
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? serviceEnrollmentAudience(NODE_ID))
    .setIssuedAt(over.iat ?? nowSec)
    .setExpirationTime(over.exp ?? nowSec + 300)
    .sign(over.key ?? signer.privateKey);
}

describe("verify enrollment token", () => {
  it("accepts a well-formed token from a trusted home and returns the claims", async () => {
    const result = await (await verifier())(await sign());
    expect(result).toMatchObject({
      ok: true,
      claims: {
        service: "git-review",
        scopes: ["knowledge:read"],
        iss: ISSUER,
      },
    });
  });

  it("refuses a token signed by another key", async () => {
    expect(
      await (await verifier())(await sign({ key: otherSigner.privateKey }))
    ).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("refuses an issuer that is not in the trusted list, without fetching its keys", async () => {
    let fetched = false;
    const v = createEnrollmentTokenVerifier({
      nodeId: NODE_ID,
      receiver: RECEIVER,
      homes: [HOME],
      keysFor: () => {
        fetched = true;
        return createLocalJWKSet({ keys: [] });
      },
      now: () => NOW,
    });
    expect(await v(await sign({ iss: "https://evil.example" }))).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(fetched).toBe(false);
  });

  it("refuses the wrong audience (another node)", async () => {
    expect(
      await (await verifier())(
        await sign({
          aud: serviceEnrollmentAudience(
            "44444444-4444-4444-8444-444444444444"
          ),
        })
      )
    ).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("OWN_TYP_AND_KIND: refuses a token with no typ, another typ, or another kind", async () => {
    const v = await verifier();
    expect(await v(await sign({ typ: null }))).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(await v(await sign({ typ: "JWT" }))).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(
      await v(await sign({ payload: { kind: "identity.attestation.v1" } }))
    ).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("SHORT_LIFE: refuses a token that lives longer than 10 minutes, an expired token and one issued in the future", async () => {
    const v = await verifier();
    expect(await v(await sign({ exp: nowSec + 601 }))).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(
      await v(await sign({ iat: nowSec - 700, exp: nowSec - 100 }))
    ).toEqual({ ok: false, reason: "invalid_token" });
    expect(
      await v(await sign({ iat: nowSec + 3600, exp: nowSec + 3700 }))
    ).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("HOME_LIMITS_THE_ASK: refuses a service the home may not sign for and a scope it may not ask for", async () => {
    const v = await verifier();
    expect(await v(await sign({ payload: { service: "outreach" } }))).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(
      await v(await sign({ payload: { scopes: ["knowledge:contribute"] } }))
    ).toEqual({ ok: false, reason: "invalid_token" });
    expect(
      await v(
        await sign({
          payload: { scopes: ["knowledge:read", "knowledge:contribute"] },
        })
      )
    ).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("CNF_IS_PUBLIC: refuses a cnf key that carries a private part, or is not X25519", async () => {
    const v = await verifier();
    expect(
      await v(await sign({ payload: { cnf: { jwk: { ...cnfPrivate } } } }))
    ).toEqual({ ok: false, reason: "invalid_token" });
    expect(
      await v(
        await sign({
          payload: {
            cnf: {
              jwk: {
                kty: "EC",
                crv: "P-256",
                x: "a".repeat(43),
                y: "a".repeat(43),
              },
            },
          },
        })
      )
    ).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("EDDSA_ONLY: refuses an HS256 token and a token that is not a JWT", async () => {
    const v = await verifier();
    const hs = await new SignJWT(claims() as never)
      .setProtectedHeader({ alg: "HS256", typ: SERVICE_ENROLLMENT_TYP })
      .setIssuer(ISSUER)
      .setAudience(serviceEnrollmentAudience(NODE_ID))
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 300)
      .sign(new TextEncoder().encode("secret-secret-secret-secret-secret!!"));
    expect(await v(hs)).toEqual({ ok: false, reason: "invalid_token" });
    expect(await v("not-a-jwt")).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(await v("")).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("FAIL_CLOSED: a key-set outage is jwks_unavailable, never an accept and never invalid_token", async () => {
    const v = createEnrollmentTokenVerifier({
      nodeId: NODE_ID,
      receiver: RECEIVER,
      homes: [HOME],
      keysFor: () => async () => {
        throw new Error("jwks down");
      },
      now: () => NOW,
    });
    expect(await v(await sign())).toEqual({
      ok: false,
      reason: "jwks_unavailable",
    });
  });
});

describe("names", () => {
  it("one principal per (issuer, service), named from verified claims", () => {
    expect(serviceKeyOf("https://cognidao.org", "git-review")).toBe(
      "https://cognidao.org#git-review"
    );
    expect(servicePrincipalName("https://cognidao.org", "git-review")).toBe(
      "git-review@cognidao.org"
    );
    expect(
      servicePrincipalName("https://test.cognidao.org", "git-review")
    ).toBe("git-review@test.cognidao.org");
  });
});

describe("seal", () => {
  it("a key sealed to cnf opens with the private key and with no other", async () => {
    const jwe = await sealToJwk("cogni_ag_sk_v2_secret", {
      kty: "OKP",
      crv: "X25519",
      x: cnfPublic.x as string,
    });
    expect(jwe.split(".")).toHaveLength(5);
    expect(jwe).not.toContain("secret");
    expect(await openSealed(jwe, cnfPrivate)).toBe("cogni_ag_sk_v2_secret");
    const stranger = await generateKeyPair("ECDH-ES", {
      crv: "X25519",
      extractable: true,
    });
    await expect(
      openSealed(jwe, await exportJWK(stranger.privateKey))
    ).rejects.toThrow();
  });
});
