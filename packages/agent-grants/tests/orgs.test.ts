// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { authorizeAccount, canApprove, type SqlTag } from "../src";
import {
  createGrantsOwnerSource,
  createOwnerSources,
  type OrgSource,
  OwnerSourceUnavailableError,
  orgSourceFromKey,
  readOrgSource,
} from "../src/orgs";
import { memoryStore } from "./memory-store";

const SRC: OrgSource = { kind: "grants", ref: "org1" };

describe("grants owner source", () => {
  const tag = (rows: Array<Record<string, unknown>>) => vi.fn(async () => rows) as unknown as SqlTag;

  it("returns the holders of a live org:owner grant on the org's account", async () => {
    const source = createGrantsOwnerSource(tag([{ principal_user_id: "alice" }, { principal_user_id: "bob" }]));
    expect(await source.owners(SRC)).toEqual(["alice", "bob"]);
  });

  it("asks only for the org:owner scope of this org, live rows only", async () => {
    const sql = vi.fn(async (_s: TemplateStringsArray, ..._v: unknown[]) => []);
    await createGrantsOwnerSource(sql as unknown as SqlTag).owners(SRC);
    const [strings, ...values] = sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const text = strings.join("?");
    expect(values).toEqual(["org:owner", "org1"]);
    expect(text).toContain("approved_by IS NOT NULL AND r.revoked_at IS NULL");
    expect(text).toContain("b.owner_user_id = ?");
  });

  it("a failed read is OwnerSourceUnavailableError, never an empty list; another kind is refused", async () => {
    const down = createGrantsOwnerSource((async () => Promise.reject(new Error("db down"))) as unknown as SqlTag);
    await expect(down.owners(SRC)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    await expect(createGrantsOwnerSource(tag([])).owners({ kind: "repo-spec", ref: "x" } as unknown as OrgSource)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("the dispatcher refuses a kind with no registered source", async () => {
    const sources = createOwnerSources([createGrantsOwnerSource(tag([{ principal_user_id: "alice" }]))]);
    expect(await sources.owners(SRC)).toEqual(["alice"]);
    await expect(sources.owners({ kind: "repo-spec", ref: "x" } as unknown as OrgSource)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("the stored key round-trips: only kind grants with a ref is a source", async () => {
    expect(orgSourceFromKey("grants", "org1")).toEqual(SRC);
    expect(orgSourceFromKey("repo-spec", "https://github.com/a/b")).toBeNull();
    expect(orgSourceFromKey("grants", null)).toBeNull();
    const one = vi.fn(async () => [{ owner_source_kind: "grants", owner_source_ref: "org1" }]) as unknown as SqlTag;
    expect(await readOrgSource(one, "org1")).toEqual(SRC);
    expect(await readOrgSource((async () => []) as unknown as SqlTag, "u")).toBeNull();
  });
});

describe("canApprove and authorizeAccount for an org-owned account", () => {
  // acct-org belongs to the org user `org1`; its owners come from the owner source and its admins from live org:admin grants.
  const store = () =>
    memoryStore({
      accounts: { org1: "acct-org", alice: "acct-a" },
      orgAccounts: { "acct-org": SRC },
      roles: [
        { principal: "owner1", scope: "org:owner", resource: "account", accountId: "acct-org" },
        { principal: "admin1", scope: "org:admin", resource: "account", accountId: "acct-org" },
      ],
    });
  const row = { resource: "account" as const, principalUserId: "agent", accountId: "acct-org" };
  const owners = (list: string[]) => ({ owners: async () => list });
  const down = { owners: async () => Promise.reject(new OwnerSourceUnavailableError("down")) };

  it("an owner of the org approves a grant on its account; a stranger is refused, a node-admin session adds nothing", async () => {
    expect(await canApprove(store(), { userId: "owner1", admin: null }, row, owners(["owner1"]))).toBe(true);
    expect(await canApprove(store(), { userId: "dave", admin: {} }, row, owners(["owner1"]))).toBe(false);
  });

  it("an org admin approves grants on the org's account too, but never an org:owner row", async () => {
    expect(await canApprove(store(), { userId: "admin1", admin: null }, row, owners(["owner1"]))).toBe(true);
    expect(await canApprove(store(), { userId: "admin1", admin: null }, { ...row, scope: "org:admin" }, owners(["owner1"]))).toBe(true);
    expect(await canApprove(store(), { userId: "admin1", admin: null }, { ...row, scope: "org:owner" }, owners(["owner1"]))).toBe(false);
    expect(await canApprove(store(), { userId: "owner1", admin: null }, { ...row, scope: "org:owner" }, owners(["owner1"]))).toBe(true);
  });

  it("an admin of another org, or of no org, approves nothing; a person's own account never admits an org admin", async () => {
    const s = memoryStore({
      accounts: { org1: "acct-org", org2: "acct-two", alice: "acct-a" },
      orgAccounts: { "acct-org": SRC, "acct-two": { kind: "grants", ref: "org2" } },
      roles: [{ principal: "admin2", scope: "org:admin", resource: "account", accountId: "acct-two" }],
    });
    expect(await canApprove(s, { userId: "admin2", admin: null }, row, owners([]))).toBe(false);
    const human = { resource: "account" as const, principalUserId: "agent", accountId: "acct-a" };
    expect(await canApprove(s, { userId: "admin2", admin: null }, human, owners([]))).toBe(false);
  });

  it("an owner who is the asking principal is refused (NO_SELF_APPROVAL)", async () => {
    expect(await canApprove(store(), { userId: "agent", admin: null }, row, owners(["agent"]))).toBe(false);
  });

  it("an unavailable owner source refuses by throwing, never by allowing", async () => {
    await expect(canApprove(store(), { userId: "bob", admin: null }, row, down)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("without owner sources an org account has no approver but its own user and its admins; a human account behaves as before", async () => {
    expect(await canApprove(store(), { userId: "bob", admin: null }, row)).toBe(false);
    expect(await canApprove(store(), { userId: "org1", admin: null }, row)).toBe(true);
    const human = { resource: "account" as const, principalUserId: "agent", accountId: "acct-a" };
    expect(await canApprove(store(), { userId: "alice", admin: null }, human, down)).toBe(true);
    expect(await canApprove(store(), { userId: "bob", admin: null }, human, owners(["bob"]))).toBe(false);
  });

  it("authorizeAccount answers owner for an owner of the org, null for anyone else, and throws on an outage", async () => {
    const input = { scope: "account:read", accountId: "acct-org" };
    expect(await authorizeAccount(store(), { ...input, callerUserId: "bob", owners: owners(["bob"]) })).toBe("owner");
    expect(await authorizeAccount(store(), { ...input, callerUserId: "dave", owners: owners(["bob"]) })).toBeNull();
    await expect(authorizeAccount(store(), { ...input, callerUserId: "dave", owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });
});

describe("authorizeAccount order: a live grant never waits on the owner read", () => {
  const down = { owners: async () => Promise.reject(new OwnerSourceUnavailableError("down")) };
  const input = { scope: "account:read", accountId: "acct-org", callerUserId: "agent" };

  it("an owner source that throws still answers delegated for a caller with a live grant, and the source is not read", async () => {
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
