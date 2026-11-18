// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/service-enrollment-config`
 * Purpose: The typed boundary of the service-enrollment secret: a missing or malformed seed fails loudly (the routes answer 503), the generated seed
 *   derives one stable key pair and kid, the public key set never carries the private member, and the node's origin and environment come from its own config.
 * Invariants: FAIL_CLOSED, GENERATED_SIGNING_KEY, PLAIN_CONFIG_IS_NOT_A_SECRET.
 * Side-effects: none
 */

import { createLocalJWKSet, jwtVerify, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  deriveServiceSigner,
  serviceEnrollmentEnvironment,
  serviceEnrollmentOrigin,
} from "@/bootstrap/service-enrollment-config";

const SEED = Buffer.alloc(32, 7).toString("base64");

describe("the service-enrollment signing seed", () => {
  it("a missing or malformed seed throws service_signer_unavailable, so the signer and jwks routes answer 503 instead of signing with nothing", async () => {
    for (const bad of [undefined, "", "not-base64!!", Buffer.alloc(31, 1).toString("base64"), Buffer.alloc(33, 1).toString("base64")])
      await expect(deriveServiceSigner(bad)).rejects.toThrow("service_signer_unavailable");
  });

  it("derives the same key pair and kid from the same seed, and another from another seed", async () => {
    const a = await deriveServiceSigner(SEED);
    const b = await deriveServiceSigner(SEED);
    const c = await deriveServiceSigner(Buffer.alloc(32, 9).toString("base64"));
    expect(b.kid).toBe(a.kid);
    expect(b.jwks).toEqual(a.jwks);
    expect(c.kid).not.toBe(a.kid);
  });

  it("serves a public key set with no private member, and the key it serves verifies what the derived key signs", async () => {
    const derived = await deriveServiceSigner(SEED);
    expect(JSON.stringify(derived.jwks)).not.toContain('"d"');
    expect(derived.jwks.keys).toHaveLength(1);
    const token = await new SignJWT({ ok: true }).setProtectedHeader({ alg: "EdDSA", kid: derived.kid }).sign(derived.key);
    await expect(jwtVerify(token, createLocalJWKSet(derived.jwks))).resolves.toBeTruthy();
  });
});

describe("this node's own origin and environment are plain config, not secrets", () => {
  it("derives the origin from APP_BASE_URL and the environment from DEPLOY_ENVIRONMENT; an explicit value overrides", () => {
    const env = { APP_BASE_URL: "https://node-template-test.cognidao.org/some/path", DEPLOY_ENVIRONMENT: "candidate-a" };
    expect(serviceEnrollmentOrigin(env)).toBe("https://node-template-test.cognidao.org");
    expect(serviceEnrollmentEnvironment(env)).toBe("candidate-a");
    expect(serviceEnrollmentOrigin({ ...env, SERVICE_ENROLLMENT_ORIGIN: "https://x.example" })).toBe("https://x.example");
    expect(serviceEnrollmentEnvironment({ ...env, SERVICE_ENROLLMENT_ENVIRONMENT: "preview" })).toBe("preview");
  });

  it("is undefined, never a guess, when the node has no base URL or environment", () => {
    expect(serviceEnrollmentOrigin({})).toBeUndefined();
    expect(serviceEnrollmentOrigin({ APP_BASE_URL: "not a url" })).toBeUndefined();
    expect(serviceEnrollmentEnvironment({})).toBeUndefined();
  });
});
