// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/service-auth`
 * Purpose: The node's thin wiring of service assertions and orgs (story.0038): trusted-homes parsing fails closed, the signer is absent until fully configured,
 *   the repo-spec is read through the GitHub contents API (never the raw CDN) with the raw Accept header, a 10 s timeout and a 64 KiB cap, a 403 or 429 is an owner
 *   outage, and the wallet mapping reads lowercase wallet bindings.
 * Scope: No network, no database.
 * Side-effects: none
 */

import { OwnerSourceUnavailableError } from "@cogni/agent-grants/orgs";
import { describe, expect, it, vi } from "vitest";
import type { AgentAuthoritySql } from "@/bootstrap/agent-authority";
import { buildSigner, fetchRepoSpecFromGithub, parseTrustedHomes, usersForWallets } from "@/bootstrap/service-auth";

const REF = "https://github.com/cogni-dao/poly";

describe("parseTrustedHomes", () => {
  it("keeps well-formed homes and drops everything else; unset or unparseable is none", () => {
    const good = { issuer: "https://cognidao.org", jwksUri: "https://cognidao.org/.well-known/jwks.json", services: ["git-review"] };
    expect(parseTrustedHomes(JSON.stringify([good, { ...good, issuer: "http://x.io" }, { ...good, jwksUri: "http://x.io/j" }, { ...good, services: [1] }, null]))).toEqual([good]);
    expect(parseTrustedHomes(undefined)).toEqual([]);
    expect(parseTrustedHomes("not json")).toEqual([]);
    expect(parseTrustedHomes('{"issuer":"x"}')).toEqual([]);
  });
});

describe("buildSigner", () => {
  it("is absent until the key, the kid and this node's origin are all set, and absent for an unusable key", () => {
    expect(buildSigner({})).toBeNull();
    expect(buildSigner({ SERVICE_ASSERTION_SIGNING_KID: "k", APP_BASE_URL: "https://node.example" })).toBeNull();
    expect(buildSigner({ SERVICE_ASSERTION_SIGNING_JWK: "{bad", SERVICE_ASSERTION_SIGNING_KID: "k", APP_BASE_URL: "https://node.example" })).toBeNull();
  });
});

const ok = (body: string, init: ResponseInit = {}) => Promise.resolve(new Response(body, { status: 200, ...init }));

describe("fetchRepoSpecFromGithub", () => {
  it("reads the default branch through the contents API with the raw Accept header, never the raw CDN", async () => {
    const fetchImpl = vi.fn((_url: unknown, _init?: RequestInit) => ok("version: 1\n"));
    expect(await fetchRepoSpecFromGithub("https://github.com/Cogni-DAO/Poly", undefined, fetchImpl as unknown as typeof fetch)).toBe("version: 1\n");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/cogni-dao/poly/contents/.cogni/repo-spec.yaml");
    expect(url).not.toContain("raw.githubusercontent.com");
    expect((init.headers as Record<string, string>).accept).toBe("application/vnd.github.raw");
    expect(init.signal).toBeDefined();
  });

  it("a monorepo path is read from that path in the same repo; a traversal or absolute path is refused before any request", async () => {
    const fetchImpl = vi.fn((_url: unknown, _init?: RequestInit) => ok("version: 1\n"));
    await fetchRepoSpecFromGithub(REF, "nodes/operator/.cogni/repo-spec.yaml", fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe("https://api.github.com/repos/cogni-dao/poly/contents/nodes/operator/.cogni/repo-spec.yaml");
    for (const path of ["../.cogni/repo-spec.yaml", "/x/.cogni/repo-spec.yaml"])
      await expect(fetchRepoSpecFromGithub(REF, path, fetchImpl as unknown as typeof fetch), path).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a 403 or 429 (rate limit), any other failure, a network error and an oversize body are OwnerSourceUnavailableError", async () => {
    for (const status of [403, 429, 404, 500]) {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response("x", { status })));
      await expect(fetchRepoSpecFromGithub(REF, undefined, fetchImpl as unknown as typeof fetch), String(status)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    }
    await expect(fetchRepoSpecFromGithub(REF, undefined, (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    const big = vi.fn(() => ok("x".repeat(64 * 1024 + 1)));
    await expect(fetchRepoSpecFromGithub(REF, undefined, big as unknown as typeof fetch)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("refuses a ref that is not a github.com repo before any request", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchRepoSpecFromGithub("https://evil.example/a/b", undefined, fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
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
