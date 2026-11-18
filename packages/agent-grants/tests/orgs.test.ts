// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { authorizeAccount, canApprove, type SqlTag } from "../src";
import {
  canonicalRepoRef,
  createOwnerSources,
  createRepoSpecOwnerSource,
  ensureOrg,
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

/** A scripted SQL tag: the idempotency decision of ensureOrg (find, then create only what is missing). */
function fakeTag(state: { org: string | null; account: string | null }) {
  const writes: string[] = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    if (text.includes("FROM agent_principals")) return Promise.resolve(state.org ? [{ user_id: state.org, owner_source_kind: "repo-spec", owner_source_ref: REF }] : []);
    if (text.includes("FROM billing_accounts")) return Promise.resolve(state.account ? [{ id: state.account }] : []);
    writes.push(text.replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" "));
    if (text.includes("INTO users")) state.org = values[0] as string;
    if (text.includes("INTO billing_accounts")) state.account = values[0] as string;
    return Promise.resolve([]);
  }) as unknown as SqlTag;
  return { tag, writes };
}

describe("ensureOrg", () => {
  it("creates the user, the org principal and one ordinary account the first time, and nothing the second", async () => {
    const state = { org: null as string | null, account: null as string | null };
    const { tag, writes } = fakeTag(state);
    const first = await ensureOrg(tag, SRC);
    expect(writes).toEqual(["INSERT INTO users", "INSERT INTO agent_principals", "INSERT INTO billing_accounts", "INSERT INTO virtual_keys"]);
    writes.length = 0;
    const again = await ensureOrg(tag, { kind: "repo-spec", ref: "https://github.com/Cogni-DAO/Poly" });
    expect(again).toEqual(first);
    expect(writes).toEqual([]);
  });

  it("repairs a missing account on an existing org and refuses a bad source", async () => {
    const { tag, writes } = fakeTag({ org: "u1", account: null });
    const org = await ensureOrg(tag, SRC);
    expect(org.userId).toBe("u1");
    expect(writes).toEqual(["INSERT INTO billing_accounts", "INSERT INTO virtual_keys"]);
    await expect(ensureOrg(tag, { kind: "repo-spec", ref: "http://github.com/a/b" })).rejects.toBeInstanceOf(InvalidOrgSourceError);
    await expect(ensureOrg(tag, { kind: "members" as "repo-spec", ref: REF })).rejects.toBeInstanceOf(InvalidOrgSourceError);
  });

  it("readOrgSource returns the source of an org user and null otherwise", async () => {
    expect(await readOrgSource(fakeTag({ org: "u1", account: null }).tag, "u1")).toEqual(SRC);
    expect(await readOrgSource(fakeTag({ org: null, account: null }).tag, "u1")).toBeNull();
  });
});
