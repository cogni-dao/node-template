// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { authorizeAccount, holdsAccountRight, roleOfScope, scopeOfRole, scopesCovering } from "../src";
import { memoryStore } from "./memory-store";

describe("rights nesting: org:owner ⊇ org:admin ⊇ account:read", () => {
  it("each scope is covered by itself and by every scope above it; any other scope covers only itself", () => {
    expect(scopesCovering("org:owner")).toEqual(["org:owner"]);
    expect(scopesCovering("org:admin")).toEqual(["org:admin", "org:owner"]);
    expect(scopesCovering("account:read")).toEqual(["account:read", "org:admin", "org:owner"]);
    expect(scopesCovering("knowledge:read")).toEqual(["knowledge:read"]);
    expect(scopeOfRole("owner")).toBe("org:owner");
    expect(roleOfScope("org:admin")).toBe("admin");
    expect(roleOfScope("org:member")).toBeNull();
  });

  const store = () =>
    memoryStore({
      roles: [
        { principal: "owner", scope: "org:owner", resource: "account", accountId: "acct-org" },
        { principal: "admin", scope: "org:admin", resource: "account", accountId: "acct-org" },
        { principal: "reader", scope: "account:read", resource: "account", accountId: "acct-org" },
        { principal: "gone", scope: "org:owner", resource: "account", accountId: "acct-org", revoked: true },
        { principal: "ended", scope: "org:admin", resource: "account", accountId: "acct-org", expiresInMs: -1000 },
        { principal: "elsewhere", scope: "org:owner", resource: "account", accountId: "acct-other" },
        { principal: "nodeadmin", scope: "org:admin" },
      ],
    });

  it("an owner satisfies owner, admin and read; an admin admin and read; a reader read only", async () => {
    const s = store();
    const can = (userId: string, scope: string) => holdsAccountRight(s, userId, scope, "acct-org");
    expect([await can("owner", "org:owner"), await can("owner", "org:admin"), await can("owner", "account:read")]).toEqual([true, true, true]);
    expect([await can("admin", "org:owner"), await can("admin", "org:admin"), await can("admin", "account:read")]).toEqual([false, true, true]);
    expect([await can("reader", "org:owner"), await can("reader", "org:admin"), await can("reader", "account:read")]).toEqual([false, false, true]);
  });

  it("a revoked, an expired, another account's and a node-level row hold nothing here", async () => {
    const s = store();
    for (const userId of ["gone", "ended", "elsewhere", "nodeadmin", "stranger"]) expect(await holdsAccountRight(s, userId, "account:read", "acct-org"), userId).toBe(false);
  });

  it("authorizeAccount(caller, org:admin, account) works for a session caller, the call billing makes (AUTHORITY_IS_NOT_KIND)", async () => {
    const s = store();
    const ask = (callerUserId: string, scope: string, via?: "session" | "bearer") => authorizeAccount(s, { callerUserId, scope, accountId: "acct-org", ...(via ? { via } : {}) });
    expect(await ask("admin", "org:admin", "session")).toBe("delegated");
    expect(await ask("owner", "org:admin", "session")).toBe("delegated");
    expect(await ask("admin", "org:admin")).toBe("delegated");
    expect(await ask("admin", "org:admin", "bearer")).toBe("delegated");
    expect(await ask("reader", "org:admin", "session")).toBeNull();
    expect(await ask("stranger", "org:admin", "session")).toBeNull();
    expect(await ask("admin", "org:owner", "session")).toBeNull();
    expect(await ask("admin", "account:read", "session")).toBe("delegated");
  });
});
