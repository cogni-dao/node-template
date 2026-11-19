// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { authorizeAccount, canApprove, type SqlTag } from "../src";
import {
  canonicalRepoRef,
  DEFAULT_REPO_SPEC_PATH,
  orgSourceFromKey,
  validRepoSpecPath,
  createIssuerOwnerSource,
  createOwnerSources,
  createRepoSpecOwnerSource,
  createGithubRepoSpecFetcher,
  ensureOrg,
  fetchRepoSpecFromGithub,
  InvalidOrgSourceError,
  MAX_OWNER_TTL_MS,
  type OrgSource,
  type OwnerSource,
  OwnerSourceUnavailableError,
  readOrgSource,
} from "../src/orgs";
import { memoryStore } from "./memory-store";

const REF = "https://github.com/cogni-dao/poly";
const SRC: OrgSource = { kind: "repo-spec", ref: REF };
const STEWARD = "0x" + "5".repeat(40);

const source = (over: Partial<Parameters<typeof createRepoSpecOwnerSource>[0]> = {}) => {
  const clock = { now: 1_000_000 };
  const fetchRepoSpec = vi.fn(async (_ref: string) => "yaml");
  // The parser returns the approvers only; the steward wallet is in the yaml but is never returned.
  const extractApprovers = vi.fn((_yaml: string) => ["0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa", "0xbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBB"]);
  const usersForWallets = vi.fn(async (wallets: string[]) => wallets.map((w) => `user-${w.slice(2, 4)}`));
  const owners = createRepoSpecOwnerSource({ fetchRepoSpec, extractApprovers, usersForWallets, now: () => clock.now, ...over });
  return { owners, clock, fetchRepoSpec, extractApprovers, usersForWallets };
};

describe("repo-spec owner source", () => {
  it("returns the users of the lowercased approvers and never asks about the steward wallet", async () => {
    const s = source();
    expect(await s.owners.owners(SRC)).toEqual(["user-aa", "user-bb"]);
    const wallets = s.usersForWallets.mock.calls[0]?.[0] ?? [];
    expect(wallets).toEqual(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
    expect(wallets).not.toContain(STEWARD);
  });

  it("caches the final list for ttlMs, then reads again, and never serves a value past its ttl", async () => {
    const s = source({ ttlMs: 60_000 });
    await s.owners.owners(SRC);
    s.clock.now += 59_999;
    await s.owners.owners(SRC);
    expect(s.fetchRepoSpec).toHaveBeenCalledTimes(1);
    expect(s.usersForWallets).toHaveBeenCalledTimes(1);
    s.clock.now += 1;
    await s.owners.owners(SRC);
    expect(s.fetchRepoSpec).toHaveBeenCalledTimes(2);
    expect(s.usersForWallets).toHaveBeenCalledTimes(2);
  });

  it("100 concurrent owners() calls on a cold cache make exactly one fetchRepoSpec and one usersForWallets call", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedFetch = vi.fn(async (_ref: string) => {
      await gate;
      return "yaml";
    });
    const s = source({ fetchRepoSpec: gatedFetch });
    const calls = Array.from({ length: 100 }, () => s.owners.owners(SRC));
    release();
    const results = await Promise.all(calls);
    expect(results.every((r) => r.join() === "user-aa,user-bb")).toBe(true);
    expect(gatedFetch).toHaveBeenCalledTimes(1);
    expect(s.usersForWallets).toHaveBeenCalledTimes(1);
    // A failed shared read rejects every waiter and leaves nothing cached.
    const failing = vi.fn(async (_ref: string) => {
      await gate;
      throw new Error("github down");
    });
    const f = source({ fetchRepoSpec: failing });
    const results2 = await Promise.allSettled(Array.from({ length: 20 }, () => f.owners.owners(SRC)));
    expect(results2.every((r) => r.status === "rejected" && r.reason instanceof OwnerSourceUnavailableError)).toBe(true);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("ttlMs 0 is no cache: every call reads fresh, with no reuse across sequential or concurrent calls", async () => {
    const s = source({ ttlMs: 0 });
    await s.owners.owners(SRC);
    await s.owners.owners(SRC);
    expect(s.fetchRepoSpec).toHaveBeenCalledTimes(2);
    await Promise.all([s.owners.owners(SRC), s.owners.owners(SRC), s.owners.owners(SRC)]);
    expect(s.fetchRepoSpec).toHaveBeenCalledTimes(5);
    expect(s.usersForWallets).toHaveBeenCalledTimes(5);
    expect(() => source({ ttlMs: -1 })).toThrow(RangeError);
    expect(() => source({ ttlMs: MAX_OWNER_TTL_MS })).not.toThrow();
  });

  it("refuses with OwnerSourceUnavailableError when the read, the parse or the mapping fails, and keeps no failure", async () => {
    const s = source();
    s.fetchRepoSpec.mockRejectedValueOnce(new Error("github down"));
    await expect(s.owners.owners(SRC)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    s.extractApprovers.mockImplementationOnce(() => {
      throw new Error("bad yaml");
    });
    await expect(s.owners.owners(SRC)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    s.usersForWallets.mockRejectedValueOnce(new Error("db down"));
    await expect(s.owners.owners(SRC)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(await s.owners.owners(SRC)).toEqual(["user-aa", "user-bb"]);
  });

  it("a failed refresh after expiry throws; the expired list is not served", async () => {
    const s = source({ ttlMs: 1000 });
    await s.owners.owners(SRC);
    s.clock.now += 1000;
    s.fetchRepoSpec.mockRejectedValueOnce(new Error("github down"));
    await expect(s.owners.owners(SRC)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("a repo-spec with zero approvers throws no_approvers, never []; the failure is not cached and no wallet mapping runs", async () => {
    const s = source();
    s.extractApprovers.mockReturnValueOnce([]);
    const refused = await s.owners.owners(SRC).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OwnerSourceUnavailableError);
    expect((refused as OwnerSourceUnavailableError).reason).toBe("no_approvers");
    expect(s.usersForWallets).not.toHaveBeenCalled();
    // Not cached: the next call reads again and succeeds once approvers are listed.
    expect(await s.owners.owners(SRC)).toEqual(["user-aa", "user-bb"]);
    expect(s.fetchRepoSpec).toHaveBeenCalledTimes(2);
  });

  it("refuses a wrong kind and a ref that is not a canonical repo url; caps ttl at five minutes", async () => {
    const s = source();
    await expect(s.owners.owners({ kind: "members" as "repo-spec", ref: REF })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    await expect(s.owners.owners({ kind: "repo-spec", ref: "https://evil.example/cogni-dao/poly" })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(() => source({ ttlMs: MAX_OWNER_TTL_MS + 1 })).toThrow(RangeError);
    expect(MAX_OWNER_TTL_MS).toBe(300_000);
  });

  it("keys the cache by the canonical ref", async () => {
    const s = source();
    await s.owners.owners(SRC);
    await s.owners.owners({ kind: "repo-spec", ref: "https://github.com/Cogni-DAO/Poly" });
    expect(s.fetchRepoSpec).toHaveBeenCalledTimes(1);
  });

  it("createOwnerSources dispatches by kind and refuses an unknown kind", async () => {
    const other: OwnerSource = { kind: "members", owners: async () => ["m1"] };
    const sources = createOwnerSources([source().owners, other]);
    expect(await sources.owners(SRC)).toEqual(["user-aa", "user-bb"]);
    expect(await sources.owners({ kind: "members" as "repo-spec", ref: "x" })).toEqual(["m1"]);
    await expect(createOwnerSources([]).owners(SRC)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });
});

describe("repo-spec owner source: malformed approver list", () => {
  it("refuses with reason malformed_spec when the extractor reports a bad approver list", async () => {
    const s = source({
      extractApprovers: () => {
        throw new Error("malformed_spec");
      },
    });
    await expect(s.owners.owners(SRC)).rejects.toMatchObject({ reason: "malformed_spec" });
  });
});

describe("canonicalRepoRef", () => {
  it("accepts github https repo urls and lowercases them; refuses everything else", () => {
    expect(canonicalRepoRef("https://github.com/Cogni-DAO/Poly")).toBe(REF);
    for (const bad of ["http://github.com/a/b", "https://github.com/a/b/", "https://github.com/a/b.git", "https://github.com/a/b?x=1", "https://github.com/a", "https://gitlab.com/a/b", "https://github.com/a/b/c", "https://github.com.evil.io/a/b"])
      expect(canonicalRepoRef(bad), bad).toBeNull();
  });
});

describe("canApprove and authorizeAccount for an org-owned account", () => {
  // acct-org belongs to the org user `org1`; its owners come from the owner source.
  const store = memoryStore({ accounts: { org1: "acct-org", alice: "acct-a" }, orgAccounts: { "acct-org": SRC } });
  const row = { resource: "account" as const, principalUserId: "agent", accountId: "acct-org" };
  const owners = (list: string[]) => ({ owners: async () => list });
  const down = { owners: async () => Promise.reject(new OwnerSourceUnavailableError("down")) };

  it("an owner of the org approves; a non-owner is refused, an admin session adds nothing", async () => {
    expect(await canApprove(store, { userId: "bob", admin: null }, row, owners(["bob", "carol"]))).toBe(true);
    expect(await canApprove(store, { userId: "dave", admin: {} }, row, owners(["bob", "carol"]))).toBe(false);
  });

  it("an owner who is the asking principal is refused (NO_SELF_APPROVAL)", async () => {
    expect(await canApprove(store, { userId: "agent", admin: null }, row, owners(["agent"]))).toBe(false);
  });

  it("an unavailable owner source refuses by throwing, never by allowing", async () => {
    await expect(canApprove(store, { userId: "bob", admin: null }, row, down)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("without owner sources an org account has no approver but its own user; a human account behaves as before", async () => {
    expect(await canApprove(store, { userId: "bob", admin: null }, row)).toBe(false);
    expect(await canApprove(store, { userId: "org1", admin: null }, row)).toBe(true);
    const human = { resource: "account" as const, principalUserId: "agent", accountId: "acct-a" };
    expect(await canApprove(store, { userId: "alice", admin: null }, human, down)).toBe(true);
    expect(await canApprove(store, { userId: "bob", admin: null }, human, owners(["bob"]))).toBe(false);
  });

  it("authorizeAccount answers owner for an owner of the org, null for anyone else, and throws on an outage", async () => {
    const input = { via: "session" as const, scope: "account:read", accountId: "acct-org" };
    expect(await authorizeAccount(store, { ...input, callerUserId: "bob", owners: owners(["bob"]) })).toBe("owner");
    expect(await authorizeAccount(store, { ...input, callerUserId: "dave", owners: owners(["bob"]) })).toBeNull();
    await expect(authorizeAccount(store, { ...input, callerUserId: "bob", owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });
});

const MONO = "nodes/operator/.cogni/repo-spec.yaml";

describe("repo-spec path", () => {
  it("the default path keeps the plain repo ref; another path adds #<path>", () => {
    expect(canonicalRepoRef("https://github.com/Cogni-DAO/Poly", DEFAULT_REPO_SPEC_PATH)).toBe(REF);
    expect(canonicalRepoRef("https://github.com/Cogni-DAO/Poly", undefined)).toBe(REF);
    expect(canonicalRepoRef(REF, MONO)).toBe(`${REF}#${MONO}`);
  });

  it("accepts a relative path ending in .cogni/repo-spec.yaml; rejects traversal, absolute, backslash and other files", () => {
    for (const ok of [".cogni/repo-spec.yaml", MONO, "a/b/c/.cogni/repo-spec.yaml"]) expect(validRepoSpecPath(ok), ok).toBe(ok);
    for (const bad of [
      "../.cogni/repo-spec.yaml",
      "nodes/../../x/.cogni/repo-spec.yaml",
      "/.cogni/repo-spec.yaml",
      "/etc/.cogni/repo-spec.yaml",
      "nodes\\operator\\.cogni\\repo-spec.yaml",
      "nodes//operator/.cogni/repo-spec.yaml",
      "./.cogni/repo-spec.yaml",
      "x.cogni/repo-spec.yaml",
      "nodes/operator/.cogni/other.yaml",
      "nodes/operator/repo-spec.yaml",
      "",
    ])
      expect(validRepoSpecPath(bad), bad).toBeNull();
    expect(canonicalRepoRef(REF, "../.cogni/repo-spec.yaml")).toBeNull();
  });

  it("the stored key round-trips to a source: default has no path, a monorepo path comes back", () => {
    expect(orgSourceFromKey("repo-spec", REF)).toEqual({ kind: "repo-spec", ref: REF });
    expect(orgSourceFromKey("repo-spec", `${REF}#${MONO}`)).toEqual({ kind: "repo-spec", ref: REF, path: MONO });
    expect(orgSourceFromKey("repo-spec", `${REF}#../x/.cogni/repo-spec.yaml`)).toBeNull();
    expect(orgSourceFromKey("members", REF)).toBeNull();
    expect(orgSourceFromKey("repo-spec", null)).toBeNull();
  });

  it("the owner source reads the path it is asked for, caches per path, and refuses a bad path without a read", async () => {
    const s = source();
    await s.owners.owners(SRC);
    await s.owners.owners({ ...SRC, path: MONO });
    await s.owners.owners({ ...SRC, path: MONO });
    expect(s.fetchRepoSpec.mock.calls).toEqual([
      [REF, DEFAULT_REPO_SPEC_PATH],
      [REF, MONO],
    ]);
    await expect(s.owners.owners({ ...SRC, path: "../.cogni/repo-spec.yaml" })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(s.fetchRepoSpec).toHaveBeenCalledTimes(2);
  });
});

/** A scripted SQL tag with state keyed by owner source, so two paths of one repo are two orgs. */
function fakeTag(state: { orgs: Map<string, string>; accounts: Map<string, string> }) {
  const writes: string[] = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    if (text.includes("FROM agent_principals") && text.includes("owner_source_ref = ?")) {
      const user = state.orgs.get(`${values[0]}|${values[1]}`);
      return Promise.resolve(user ? [{ user_id: user }] : []);
    }
    if (text.includes("FROM agent_principals")) {
      const entry = [...state.orgs].find(([, user]) => user === values[0]);
      const [kind, ref] = entry ? entry[0].split("|") : [];
      return Promise.resolve(entry ? [{ owner_source_kind: kind, owner_source_ref: ref }] : []);
    }
    if (text.includes("FROM billing_accounts")) {
      const id = state.accounts.get(String(values[0]));
      return Promise.resolve(id ? [{ id }] : []);
    }
    writes.push(text.replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" "));
    if (text.includes("INTO agent_principals")) state.orgs.set(`${values[1]}|${values[2]}`, values[0] as string);
    if (text.includes("INTO billing_accounts")) state.accounts.set(values[1] as string, values[0] as string);
    return Promise.resolve([]);
  }) as unknown as SqlTag;
  return { tag, writes };
}

const emptyState = () => ({ orgs: new Map<string, string>(), accounts: new Map<string, string>() });

describe("ensureOrg", () => {
  it("creates the user, the org principal and one ordinary account the first time, and nothing the second", async () => {
    const { tag, writes } = fakeTag(emptyState());
    const first = await ensureOrg(tag, SRC);
    expect(writes).toEqual(["INSERT INTO users", "INSERT INTO agent_principals", "INSERT INTO billing_accounts", "INSERT INTO virtual_keys"]);
    writes.length = 0;
    const again = await ensureOrg(tag, { kind: "repo-spec", ref: "https://github.com/Cogni-DAO/Poly", path: DEFAULT_REPO_SPEC_PATH });
    expect(again).toEqual(first);
    expect(writes).toEqual([]);
  });

  it("two paths in one repo are two orgs; each is idempotent; the default keeps the plain ref as its key", async () => {
    const state = emptyState();
    const { tag } = fakeTag(state);
    const root = await ensureOrg(tag, SRC);
    const mono = await ensureOrg(tag, { ...SRC, path: MONO });
    expect(mono.userId).not.toBe(root.userId);
    expect(mono.billingAccountId).not.toBe(root.billingAccountId);
    expect(await ensureOrg(tag, { ...SRC, path: MONO })).toEqual(mono);
    expect([...state.orgs.keys()].sort()).toEqual([`repo-spec|${REF}`, `repo-spec|${REF}#${MONO}`].sort());
    expect(await readOrgSource(tag, mono.userId)).toEqual({ kind: "repo-spec", ref: REF, path: MONO });
    expect(await readOrgSource(tag, root.userId)).toEqual(SRC);
  });

  it("repairs a missing account on an existing org and refuses a bad source, including a traversal or absolute path", async () => {
    const state = emptyState();
    state.orgs.set(`repo-spec|${REF}`, "u1");
    const { tag, writes } = fakeTag(state);
    const org = await ensureOrg(tag, SRC);
    expect(org.userId).toBe("u1");
    expect(writes).toEqual(["INSERT INTO billing_accounts", "INSERT INTO virtual_keys"]);
    await expect(ensureOrg(tag, { kind: "repo-spec", ref: "http://github.com/a/b" })).rejects.toBeInstanceOf(InvalidOrgSourceError);
    await expect(ensureOrg(tag, { kind: "members" as "repo-spec", ref: REF })).rejects.toBeInstanceOf(InvalidOrgSourceError);
    for (const path of ["../.cogni/repo-spec.yaml", "/abs/.cogni/repo-spec.yaml", "a\\.cogni/repo-spec.yaml", "nodes/operator/other.yaml"])
      await expect(ensureOrg(tag, { ...SRC, path }), path).rejects.toBeInstanceOf(InvalidOrgSourceError);
  });

  it("readOrgSource returns the source of an org user and null otherwise", async () => {
    const state = emptyState();
    state.orgs.set(`repo-spec|${REF}`, "u1");
    expect(await readOrgSource(fakeTag(state).tag, "u1")).toEqual(SRC);
    expect(await readOrgSource(fakeTag(emptyState()).tag, "u1")).toBeNull();
  });
});

describe("authorizeAccount order: a live grant never waits on the owner read", () => {
  const down = { owners: async () => Promise.reject(new OwnerSourceUnavailableError("github down")) };
  const input = { via: "bearer" as const, scope: "account:read", accountId: "acct-org", callerUserId: "agent" };

  it("an owner source that throws still answers delegated for a bearer with a live grant, and the source is not read", async () => {
    const store = memoryStore({
      accounts: { org1: "acct-org" },
      orgAccounts: { "acct-org": SRC },
      roles: [{ principal: "agent", scope: "account:read", resource: "account", accountId: "acct-org" }],
    });
    const read = vi.fn(down.owners);
    expect(await authorizeAccount(store, { ...input, owners: { owners: read } })).toBe("delegated");
    expect(read).not.toHaveBeenCalled();
  });

  it("with no live grant the owner read decides, and an outage refuses by throwing", async () => {
    const store = memoryStore({ accounts: { org1: "acct-org" }, orgAccounts: { "acct-org": SRC } });
    await expect(authorizeAccount(store, { ...input, owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(await authorizeAccount(store, { ...input, owners: { owners: async () => ["agent"] } })).toBe("owner");
  });
});

const ok = (body: string, init: ResponseInit = {}) => Promise.resolve(new Response(body, { status: 200, ...init }));

describe("fetchRepoSpecFromGithub", () => {
  it("reads the default branch through the contents API with the raw Accept header, never the raw CDN, and sends no token unless given", async () => {
    const fetchImpl = vi.fn((_url: unknown, _init?: RequestInit) => ok("version: 1\n"));
    expect(await fetchRepoSpecFromGithub("https://github.com/Cogni-DAO/Poly", undefined, { fetch: fetchImpl as unknown as typeof fetch })).toBe("version: 1\n");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/cogni-dao/poly/contents/.cogni/repo-spec.yaml");
    const headers = init.headers as Record<string, string>;
    expect(headers.accept).toBe("application/vnd.github.raw");
    expect(headers.authorization).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeDefined();
  });

  it("sends the optional token as a bearer", async () => {
    const fetchImpl = vi.fn((_url: unknown, _init?: RequestInit) => ok("x"));
    await fetchRepoSpecFromGithub(REF, undefined, { fetch: fetchImpl as unknown as typeof fetch, token: async () => "ghp_test" });
    expect(((fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe("Bearer ghp_test");
    // A provider that yields nothing sends nothing; a provider that throws is an owner outage.
    await fetchRepoSpecFromGithub(REF, undefined, { fetch: fetchImpl as unknown as typeof fetch, token: async () => undefined });
    expect(((fetchImpl.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBeUndefined();
    await expect(
      fetchRepoSpecFromGithub(REF, undefined, { fetch: fetchImpl as unknown as typeof fetch, token: async () => Promise.reject(new Error("no installation")) })
    ).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("createGithubRepoSpecFetcher is a ready-made fetchRepoSpec that asks the provider for a fresh token per read", async () => {
    const fetchImpl = vi.fn((_url: unknown, _init?: RequestInit) => ok("version: 1\n"));
    const token = vi.fn(async () => "t1");
    const fetchRepoSpec = createGithubRepoSpecFetcher({ fetch: fetchImpl as unknown as typeof fetch, token });
    await fetchRepoSpec(REF, MONO);
    await fetchRepoSpec(REF, MONO);
    expect(token).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[0] as [string])[0]).toContain("/contents/nodes/operator/.cogni/repo-spec.yaml");
  });

  it("a monorepo path is read from that path; a traversal or absolute path is refused before any request", async () => {
    const fetchImpl = vi.fn((_url: unknown, _init?: RequestInit) => ok("version: 1\n"));
    await fetchRepoSpecFromGithub(REF, MONO, { fetch: fetchImpl as unknown as typeof fetch });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe("https://api.github.com/repos/cogni-dao/poly/contents/nodes/operator/.cogni/repo-spec.yaml");
    for (const path of ["../.cogni/repo-spec.yaml", "/x/.cogni/repo-spec.yaml"])
      await expect(fetchRepoSpecFromGithub(REF, path, { fetch: fetchImpl as unknown as typeof fetch }), path).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a 403 or 429 (rate limit), any other failure, a network error and an oversize body are OwnerSourceUnavailableError", async () => {
    for (const status of [403, 429, 404, 500]) {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response("x", { status })));
      await expect(fetchRepoSpecFromGithub(REF, undefined, { fetch: fetchImpl as unknown as typeof fetch }), String(status)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    }
    await expect(fetchRepoSpecFromGithub(REF, undefined, { fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    const big = vi.fn(() => ok("x".repeat(64 * 1024 + 1)));
    await expect(fetchRepoSpecFromGithub(REF, undefined, { fetch: big as unknown as typeof fetch })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    const exact = vi.fn(() => ok("y".repeat(64 * 1024)));
    expect((await fetchRepoSpecFromGithub(REF, undefined, { fetch: exact as unknown as typeof fetch })).length).toBe(64 * 1024);
  });

  it("refuses a ref that is not a github.com repo before any request", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchRepoSpecFromGithub("https://evil.example/a/b", undefined, { fetch: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("issuer-keyed org (connect from home)", () => {
  const ISSUER_SRC: OrgSource = { kind: "issuer", ref: "https://toks5-test.cognidao.org" };

  it("ensureOrg keys an org by the issuer origin, idempotently, with its own user and one ordinary account", async () => {
    const state = emptyState();
    const { tag, writes } = fakeTag(state);
    const first = await ensureOrg(tag, ISSUER_SRC);
    expect(writes).toEqual(["INSERT INTO users", "INSERT INTO agent_principals", "INSERT INTO billing_accounts", "INSERT INTO virtual_keys"]);
    expect([...state.orgs.keys()]).toEqual(["issuer|https://toks5-test.cognidao.org"]);
    writes.length = 0;
    expect(await ensureOrg(tag, ISSUER_SRC)).toEqual(first);
    expect(writes).toEqual([]);
    expect(await readOrgSource(tag, first.userId)).toEqual(ISSUER_SRC);
  });

  it("a candidate and a production origin are two orgs, and a repo-spec org never collides with an issuer org", async () => {
    const state = emptyState();
    const { tag } = fakeTag(state);
    const a = await ensureOrg(tag, ISSUER_SRC);
    const b = await ensureOrg(tag, { kind: "issuer", ref: "https://toks5.cognidao.org" });
    const c = await ensureOrg(tag, SRC);
    expect(new Set([a.userId, b.userId, c.userId]).size).toBe(3);
  });

  it("refuses an issuer ref that is not a canonical https origin", async () => {
    const { tag, writes } = fakeTag(emptyState());
    for (const ref of ["http://x.example.org", "https://x.example.org/", "https://x.example.org/path", "not a url", "https://user@x.example.org"])
      await expect(ensureOrg(tag, { kind: "issuer", ref }), ref).rejects.toBeInstanceOf(InvalidOrgSourceError);
    expect(writes).toEqual([]);
  });

  it("orgSourceFromKey reads an issuer key and refuses a non-origin", () => {
    expect(orgSourceFromKey("issuer", "https://a.example.org")).toEqual({ kind: "issuer", ref: "https://a.example.org" });
    expect(orgSourceFromKey("issuer", "https://a.example.org/x")).toBeNull();
    expect(orgSourceFromKey("issuer", null)).toBeNull();
  });

  it("the issuer owner source has no owners: every read throws issuer_has_no_owners, so no owner list can approve for it", async () => {
    const owners = createOwnerSources([createIssuerOwnerSource(), source().owners]);
    await expect(owners.owners(ISSUER_SRC)).rejects.toMatchObject({ name: "OwnerSourceUnavailableError", reason: "issuer_has_no_owners" });
    // canApprove over an issuer-keyed account fails closed instead of allowing.
    const store = memoryStore({ accounts: { org1: "acct-org" }, orgAccounts: { "acct-org": ISSUER_SRC } });
    await expect(canApprove(store, { userId: "bob", admin: null }, { resource: "account", principalUserId: "agent", accountId: "acct-org" }, owners)).rejects.toBeInstanceOf(
      OwnerSourceUnavailableError
    );
  });
});
