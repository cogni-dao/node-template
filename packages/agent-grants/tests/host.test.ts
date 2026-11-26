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

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  AGENT_HOST_EVENTS,
  buildPermissionCatalog,
  buildRequiresById,
  createAdminCheck,
  createAgentToolAuthority,
  type AgentAuthorityPort,
  type AgentAuthoritySql,
} from "../src/host";
import type { GuardDeps } from "../src/guard";

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

  it("derives its declared scopes from the tool records and carries the org, service and payer methods a node no longer keeps beside it", () => {
    expect(authority.declaredScopes).toContain("work_item:transition");
    for (const method of ["requestPayerBinding", "ensureOrg", "requestServiceAccess", "resolveBillTo", "billToScopeUserFor", "connectOrg", "verifyOrgCall", "setSuspension"])
      expect(authority).toHaveProperty(method);
  });


  it("signs the org statement once per change of its facts, not once per hit, and signs again at once when an approver is removed", async () => {
    let signs = 0;
    let admins = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"];
    const issuing = createAgentToolAuthority({
      sql,
      nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      log,
      tools: [],
      graphs: [],
      systemUserIds: [],
      nodeId: "node-1",
      signer: async () => ({ signClaims: async () => `jwt-${++signs}`, jwks: () => ({ keys: [] }), sign: async () => "", authorizationHeader: async () => "" }) as never,
      orgIdentity: { origin: "https://me.example.com", version: 1_790_000_000, facts: () => ({ dao: null, admins, services: ["node-ai"], commit: null }) },
    });
    expect(await issuing.orgStatement()).toBe("jwt-1");
    expect(await issuing.orgStatement()).toBe("jwt-1");
    expect(signs).toBe(1);
    admins = ["0x00000000000000000000000000000000000000a1"];
    expect(await issuing.orgStatement()).toBe("jwt-2");
  });

  it("re-posts connect to the nodes it is CONNECTED to when an approver changes, and only then, without making the statement call wait for them", async () => {
    const rows = [
      { origin: "https://a.example.com", status: "connected", reason: null },
      { origin: "https://b.example.com", status: "disconnected", reason: null },
    ];
    const tag = (async (strings: TemplateStringsArray) => (strings.join("?").includes("FROM org_connections") ? rows : [])) as never;
    const posted: string[] = [];
    const doFetch = (async (url: URL) => {
      if (url.pathname === "/.well-known/agent.json") return new Response(JSON.stringify({ nodeId: "a" }));
      posted.push(url.origin + url.pathname);
      return new Response(JSON.stringify({ status: "connected" }));
    }) as unknown as typeof fetch;
    let admins = ["0x00000000000000000000000000000000000000a1"];
    const repostLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const issuing = createAgentToolAuthority({
      sql: tag,
      nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      log: repostLog,
      tools: [],
      graphs: [],
      systemUserIds: [],
      nodeId: "node-1",
      directory: [
        { origin: "https://a.example.com", nodeId: "a" },
        { origin: "https://b.example.com", nodeId: "b" },
      ],
      fetch: doFetch,
      signer: async () => ({ signClaims: async () => "jwt", jwks: () => ({ keys: [] }), sign: async () => "", authorizationHeader: async () => "Bearer x" }) as never,
      orgIdentity: { origin: "https://me.example.com", version: 1_790_000_000, facts: () => ({ dao: null, admins, services: [], commit: null }) },
    });
    await issuing.orgStatement();
    admins = [...admins, "0x00000000000000000000000000000000000000a2"];
    await issuing.orgStatement();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // One boot pass (the first signing) and one pass for the change: each asks the listed node once, and the node whose discovery names another id (b) is never posted to.
    expect(posted).toEqual(["https://a.example.com/api/v1/public/orgs/connect", "https://a.example.com/api/v1/public/orgs/connect"]);
    expect(repostLog.info.mock.calls.filter((c) => c[0]?.act === "org.connection.refresh").every((c) => typeof c[0]?.actor === "string")).toBe(true);
  });

  it("a change of facts DURING a re-post run earns exactly one more run, so the last change is always told", async () => {
    const rows = [{ origin: "https://a.example.com", status: "connected", reason: null }];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lists = 0;
    const tag = (async (strings: TemplateStringsArray) => {
      if (!strings.join("?").includes("FROM org_connections")) return [];
      lists += 1;
      if (lists === 1) await gate;
      return rows;
    }) as never;
    const posted: string[] = [];
    const doFetch = (async (url: URL) => {
      if (url.pathname === "/.well-known/agent.json") return new Response(JSON.stringify({ nodeId: "a" }));
      posted.push(url.pathname);
      return new Response(JSON.stringify({ status: "connected" }));
    }) as unknown as typeof fetch;
    let admins = ["0x00000000000000000000000000000000000000a1"];
    const authority = createAgentToolAuthority({
      sql: tag,
      nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tools: [],
      graphs: [],
      systemUserIds: [],
      nodeId: "node-1",
      directory: [{ origin: "https://a.example.com", nodeId: "a" }],
      fetch: doFetch,
      signer: async () => ({ signClaims: async () => "jwt", jwks: () => ({ keys: [] }), sign: async () => "", authorizationHeader: async () => "Bearer x" }) as never,
      orgIdentity: { origin: "https://me.example.com", version: 1_790_000_000, facts: () => ({ dao: null, admins, services: [], commit: null }) },
    });
    await authority.orgStatement();
    admins = [...admins, "0x00000000000000000000000000000000000000a2"];
    await authority.orgStatement();
    admins = [...admins, "0x00000000000000000000000000000000000000a3"];
    await authority.orgStatement();
    release();
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toHaveLength(2);
  });

  it("signs the build's version, and the FIRST signing after boot asks the connected AND unreachable nodes below that version (once, bounded), never a node that is up to date or when there is no build version", async () => {
    const lists: unknown[][] = [];
    const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("FROM org_connections")) lists.push(values);
      return [];
    }) as never;
    const claims: Array<Record<string, unknown>> = [];
    const make = (version: number | undefined) =>
      createAgentToolAuthority({
        sql: tag,
        nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        tools: [],
        graphs: [],
        systemUserIds: [],
        nodeId: "node-1",
        signer: async () =>
          ({
            signClaims: async (c: Record<string, unknown>) => {
              claims.push(c);
              return "jwt";
            },
            jwks: () => ({ keys: [] }),
            sign: async () => "",
            authorizationHeader: async () => "",
          }) as never,
        orgIdentity: { origin: "https://me.example.com", version, facts: () => ({ dao: null, admins: ["0x00000000000000000000000000000000000000a1"], services: [], commit: null }) },
      });
    const booted = make(1_799_999_000);
    await booted.orgStatement();
    await vi.waitFor(() => expect(lists).toHaveLength(1));
    expect(claims[0]?.version).toBe(1_799_999_000);
    // [after, statuses, statuses, below, below, ...]: the filter names both statuses and this build's version.
    expect(lists[0]).toContainEqual(["connected", "unreachable"]);
    // `connectsOnly`: an unreachable node counts only when the org's last operation to it was a connect.
    expect(lists[0]).toContain(true);
    expect(lists[0]).toContain(1_799_999_000);
    // A second signing of the same facts is a reuse: no second pass.
    await booted.orgStatement();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lists).toHaveLength(1);
    expect(claims).toHaveLength(1);
  });

  it("signs NO statement without a build version (the route answers 404), says so in the log, and starts no pass: the issue time is never a version", async () => {
    const lists: unknown[] = [];
    const tag = (async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("FROM org_connections")) lists.push(1);
      return [];
    }) as never;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let signs = 0;
    const authority = createAgentToolAuthority({
      sql: tag,
      nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      log,
      tools: [],
      graphs: [],
      systemUserIds: [],
      nodeId: "node-1",
      signer: async () => ({ signClaims: async () => `jwt-${++signs}`, jwks: () => ({ keys: [] }), sign: async () => "", authorizationHeader: async () => "" }) as never,
      orgIdentity: { origin: "https://me.example.com", facts: () => ({ dao: null, admins: ["0x00000000000000000000000000000000000000a1"], services: [], commit: null }) },
    });
    expect(await authority.orgStatement()).toBeNull();
    expect(signs).toBe(0);
    expect(log.warn.mock.calls.some((c) => c[0]?.act === "org.statement.unversioned")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lists).toHaveLength(0);
  });

  it("funding: logOrgFunded logs the org.act line only for a row that was written (a repeated payment id logs nothing), and resolveFundingAccount never opens a transaction", async () => {
    const orgRow = { org_user_id: "org-user", billing_account_id: "acct-org", node_id: "n", origin: "https://org.example.com", admins: [], services: [], statement_version: 1 };
    const seen = new Set<string>();
    let begins = 0;
    const tag = Object.assign(
      (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        if (text.includes("FROM org_accounts")) return values.includes("acct-org") ? [orgRow] : [];
        if (text.includes("FROM users")) return [{ present: 1 }];
        if (text.includes("FROM billing_accounts")) return [{ owner_user_id: "someone-else" }];
        if (text.includes("INSERT INTO org_events")) {
          const ref = String(values.find((v) => typeof v === "string" && v.includes("paymentRef")));
          if (seen.has(ref)) return [];
          seen.add(ref);
          return [{ id: "e" }];
        }
        return [];
      }) as never,
      {
        begin: async (fn: (t: unknown) => unknown) => {
          begins += 1;
          return fn(tag);
        },
      }
    );
    const fundLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const funding = createAgentToolAuthority({
      sql: tag as unknown as AgentAuthoritySql,
      nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      log: fundLog,
      tools: [],
      graphs: [],
      systemUserIds: [],
      ensureBillingAccount: async (userId) => `acct-of-${userId}`,
      // The org's statement cannot be read: the org path must answer statement_unavailable without ever beginning a transaction.
      orgFetch: async () => {
        throw new Error("down");
      },
    });
    expect(await funding.resolveFundingAccount({ userId: "u1" })).toEqual({ billingAccountId: "acct-of-u1", chargeScopeUserId: "u1" });
    await expect(funding.resolveFundingAccount({ userId: "u1", billingAccountId: "acct-theirs" })).rejects.toMatchObject({ code: "not_allowed" });
    await expect(funding.resolveFundingAccount({ userId: "u1", billingAccountId: "acct-org" })).rejects.toMatchObject({ code: "statement_unavailable" });
    expect(begins).toBe(0);
    const input = { orgBillingAccountId: "acct-org", actorUserId: "admin-1", amountCredits: 700, paymentRef: "pay_1" };
    expect(await funding.logOrgFunded(input)).toEqual({ recorded: true });
    expect(await funding.logOrgFunded(input)).toEqual({ recorded: false });
    const funded = fundLog.info.mock.calls.filter((c) => c[0]?.act === "org.funded");
    expect(funded).toHaveLength(1);
    expect(funded[0]?.[0]).toMatchObject({ amountCredits: 700, actor: "admin-1" });
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

  it("satisfies the in-process provider's authority shape structurally, so the provider needs no agent-grants import", () => {
    // The provider's own type (today's `ProviderAgentAuthority`), written out here without importing it.
    interface ProviderShape {
      resolvePrincipal(slug: string): Promise<string | null>;
      readonly guardDeps: Omit<GuardDeps, "runAs">;
    }
    expectTypeOf(authority).toExtend<ProviderShape>();
    expectTypeOf<AgentAuthorityPort>().toExtend<ProviderShape>();
    expect(typeof authority.resolvePrincipal).toBe("function");
    expect(Object.keys(authority.guardDeps).sort()).toEqual(["adminCheck", "onDecision", "withStore"]);
  });
});
