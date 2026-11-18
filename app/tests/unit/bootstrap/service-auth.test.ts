// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/service-auth`
 * Purpose: The node's composition of service assertions and orgs (story.0038). The GitHub read and the trusted-homes parser are package code with package tests;
 *   here: the signer is absent when not configured, loud (one warning naming the reason, never the key) when partly configured or unusable, a valid key signs and
 *   publishes; refusals log at debug for routine noise and warn otherwise; the wallet mapping reads lowercase wallet bindings.
 * Scope: No network, no database.
 * Side-effects: none
 */

import { createServiceAssertionSigner } from "@cogni/agent-grants/service-auth";
import { describe, expect, it, vi } from "vitest";
import type { AgentAuthoritySql } from "@/bootstrap/agent-authority";
import { buildSigner, createServiceAuth, usersForWallets } from "@/bootstrap/service-auth";

const logger = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() });

async function jwk() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const k = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { kty: string; crv: string; d: string; x: string };
  return { kty: k.kty, crv: k.crv, d: k.d, x: k.x };
}

describe("buildSigner", () => {
  const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const base = { APP_BASE_URL: "https://node.example" };

  it("is absent and silent when no seed is set (this node is not a home)", async () => {
    const log = logger();
    expect(await buildSigner({}, log)).toBeNull();
    expect(await buildSigner(base, log)).toBeNull();
    expect(await buildSigner({ ...base, SERVICE_ASSERTION_SIGNING_SEED: "" }, log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("a valid seed gives a signer whose jwks carries only public members and a thumbprint kid", async () => {
    const signer = await buildSigner({ ...base, SERVICE_ASSERTION_SIGNING_SEED: SEED }, logger());
    const [key] = signer?.jwks().keys ?? [];
    expect(key).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" });
    expect(key?.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(signer?.jwks())).not.toContain(SEED);
    expect(Object.keys(key ?? {}).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
  });

  it("a malformed seed or an unusable origin is null with ONE warning naming the reason, never the value", async () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ ...base, SERVICE_ASSERTION_SIGNING_SEED: "not-hex-at-all" }, "signing_seed_malformed"],
      [{ ...base, SERVICE_ASSERTION_SIGNING_SEED: SEED.slice(2) }, "signing_seed_malformed"],
      [{ ...base, SERVICE_ASSERTION_SIGNING_SEED: `${SEED}00` }, "signing_seed_malformed"],
      [{ SERVICE_ASSERTION_SIGNING_SEED: SEED }, "app_base_url_unusable"],
      [{ SERVICE_ASSERTION_SIGNING_SEED: SEED, APP_BASE_URL: "not a url" }, "app_base_url_unusable"],
    ];
    for (const [env, reason] of cases) {
      const log = logger();
      expect(await buildSigner(env, log), reason).toBeNull();
      expect(log.warn, reason).toHaveBeenCalledTimes(1);
      const [fields] = log.warn.mock.calls[0] as [Record<string, unknown>];
      expect(fields.reason).toBe(reason);
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain(env.SERVICE_ASSERTION_SIGNING_SEED ?? "never-empty-match");
    }
  });
});

describe("createServiceAuth: refusal log levels", () => {
  const rig = async (code: "untrusted_issuer" | "malformed" | "bad_signature" | "replayed") => {
    const log = logger();
    const auth = createServiceAuth({ env: {}, trustedHomes: [], nodeId: "node-x", sql: (() => Promise.resolve([])) as unknown as AgentAuthoritySql, log: log as never });
    // No trusted home is configured, so any well-formed token is `untrusted_issuer` and junk is `malformed`.
    const key = await jwk();
    const signer = createServiceAssertionSigner({ issuer: "https://home.example", kid: "k", privateJwk: key as never });
    const token = code === "malformed" ? "junk" : await signer.sign({ service: "git-review", audienceNodeId: "node-x", scope: "knowledge:read" });
    await auth.verify(token);
    return log;
  };

  it("untrusted_issuer and malformed are debug; the issuer and service of a parsed claim set are logged, never the token", async () => {
    const untrusted = await rig("untrusted_issuer");
    expect(untrusted.debug).toHaveBeenCalledTimes(1);
    expect(untrusted.warn).not.toHaveBeenCalled();
    expect(untrusted.debug.mock.calls[0]?.[0]).toMatchObject({ code: "untrusted_issuer", issuer: "https://home.example", service: "git-review" });
    const malformed = await rig("malformed");
    expect(malformed.debug).toHaveBeenCalledTimes(1);
    expect(malformed.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(malformed.debug.mock.calls)).not.toContain("junk");
  });
});

describe("usersForWallets", () => {
  it("maps lowercase wallets to the users that bound them, and asks nothing for none", async () => {
    const seen: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push([strings.join("?"), ...values]);
      return Promise.resolve([{ user_id: "u1" }, { user_id: "u2" }]);
    }) as unknown as AgentAuthoritySql;
    expect(await usersForWallets(sql, ["0xabc"])).toEqual(["u1", "u2"]);
    expect(String(seen[0]?.[0])).toContain("provider = 'wallet'");
    expect(seen[0]?.[1]).toEqual(["0xabc"]);
    seen.length = 0;
    expect(await usersForWallets(sql, [])).toEqual([]);
    expect(seen).toEqual([]);
  });
});
