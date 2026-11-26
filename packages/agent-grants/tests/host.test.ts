// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/host`
 * Purpose: The host's pure parts and its authority object work from the package entry alone (task.0175): the permission catalog over plain
 *   `{ id, requires }` records, the admin check over wallet bindings, and an authority built over fakes.
 * Scope: Fake SQL tag and fake logger. No database, no node app.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  AGENT_HOST_EVENTS,
  buildPermissionCatalog,
  buildRequiresById,
  createAdminCheck,
  createAgentToolAuthority,
  type AgentAuthoritySql,
} from "../src/host";

const requires = { scope: "work_item:transition", kind: "node", subject: "member", label: "Move work items", description: "Change a work item's stage" } as const;

describe("permission catalog", () => {
  it("is built from plain { id, requires } records, with no contract type", () => {
    const byId = buildRequiresById([
      { id: "core__work_item_update", requires },
      { id: "core__read_only_tool" },
    ]);
    expect(Object.keys(byId)).toEqual(["core__work_item_update"]);
    const catalog = buildPermissionCatalog(byId);
    expect(catalog.declaredScopes).toContain("work_item:transition");
    expect(catalog.scopeKinds["work_item:transition"]).toBe("node");
    expect(catalog.declarations["work_item:transition"]).toEqual({ label: requires.label, description: requires.description });
  });
});

const sqlOf = (wallets: string[]) => (async () => wallets.map((external_id) => ({ external_id }))) as never;

describe("admin check over wallet bindings", () => {
  const roster = (listed: string[], unavailable = false) => ({
    check: async ({ walletAddress }: { userId: string; walletAddress?: string }) =>
      unavailable
        ? ({ ok: false, errorCode: "authz_unavailable" } as const)
        : walletAddress && listed.includes(walletAddress)
          ? ({ ok: true } as const)
          : ({ ok: false, errorCode: "authz_denied" } as const),
  });

  it("allows any bound wallet the roster lists", async () => {
    expect(await createAdminCheck(sqlOf(["0xa", "0xb"]), roster(["0xb"]))("u1")).toBe("allow");
  });
  it("denies a user with no bound wallet and an unlisted wallet", async () => {
    expect(await createAdminCheck(sqlOf([]), roster(["0xb"]))("u1")).toBe("denied");
    expect(await createAdminCheck(sqlOf(["0xa"]), roster(["0xb"]))("u1")).toBe("denied");
  });
  it("is unavailable when the roster is not configured", async () => {
    expect(await createAdminCheck(sqlOf(["0xa"]), roster([], true))("u1")).toBe("unavailable");
    expect(await createAdminCheck(sqlOf([]), roster([], true))("u1")).toBe("unavailable");
  });
});

describe("createAgentToolAuthority", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sql = Object.assign(sqlOf([]), {
    begin: async () => {
      throw Object.assign(new Error("down"), { code: "CONNECTION_CLOSED" });
    },
  }) as unknown as AgentAuthoritySql;
  const authority = createAgentToolAuthority({
    sql,
    nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
    log,
    tools: [{ id: "core__work_item_update", requires }],
    graphs: [{ principal: "prioritizer", toolIds: ["core__work_item_update"] }],
    systemUserIds: [],
  });

  it("derives its declared scopes from the tool records, with no org, service or payer method", () => {
    expect(authority.declaredScopes).toContain("work_item:transition");
    expect(authority).not.toHaveProperty("requestPayerBinding");
    expect(authority).not.toHaveProperty("ensureOrg");
    expect(authority).not.toHaveProperty("requestServiceAccess");
  });

  it("logs one unavailable event under the package-owned name when the store fails", async () => {
    await expect(authority.resolvePrincipal("prioritizer")).rejects.toThrow("down");
    expect(log.error.mock.calls[0]?.[1]).toBe(AGENT_HOST_EVENTS.rolesUnavailable);
  });

  it("answers a route with no declared requires as a logged policy denial", async () => {
    const decision = await authority.authorizeRoute({ toolId: "unknown", routeId: "r", userId: "u", via: "bearer" });
    expect(decision).toMatchObject({ decision: "deny", code: "policy_denied" });
    expect(log.warn.mock.calls.at(-1)?.[1]).toBe(AGENT_HOST_EVENTS.toolAuthz);
  });
});
