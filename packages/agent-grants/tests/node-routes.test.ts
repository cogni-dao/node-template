// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/node-routes`
 * Purpose: NODE_ADDS_ONLY. A node's route twins and route-only capabilities join the package baseline through `AgentRoutes`; any collision throws; a scope
 *   declared twice with different fields throws; the exported parity suite runs over the composed set and fails on a node tool nobody twinned.
 * Scope: Pure functions and an authority over fakes. No database.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { type AgentAuthoritySql, buildPermissionCatalog, buildRequiresById, createAgentToolAuthority } from "../src/host";
import { composeAgentRoutes, NO_ROUTE_TWIN, ROUTE_ONLY_CAPABILITIES, SAME_DOOR_ROUTES } from "../src/same-door";
import { runSameDoorParity, SAME_DOOR_PARITY_RULES, unmappedWriteTools } from "../src/same-door-parity";
import type { ToolRequires } from "../src/types";

const trade: ToolRequires = {
  scope: "trading:place_order",
  kind: "node",
  subject: "member",
  label: "Place trades",
  description: "Place orders from the node's own wallet",
};
const audit: ToolRequires = {
  scope: "trading:audit",
  kind: "node",
  subject: "member",
  label: "Read the trade audit",
  description: "Read this node's trade history",
};
const nodeRoutes = {
  sameDoorRoutes: { poly__place_order: { scope: trade.scope, routes: ["poly.orders.create"] } },
  routeOnlyCapabilities: { "trading.audit": { requires: audit, routes: ["poly.audit.list"] } },
  noRouteTwin: { poly__sandbox_probe: "runs inside the node's own sandbox; no route twins it" },
};

describe("composeAgentRoutes", () => {
  it("is the package baseline when a node adds nothing", () => {
    const composed = composeAgentRoutes();
    expect(composed.sameDoorRoutes).toEqual(SAME_DOOR_ROUTES);
    expect(composed.routeOnlyCapabilities).toEqual(ROUTE_ONLY_CAPABILITIES);
    expect(composed.noRouteTwin).toEqual(NO_ROUTE_TWIN);
  });

  it("adds a node's twins, route-only capabilities and exemptions beside the baseline", () => {
    const composed = composeAgentRoutes(nodeRoutes);
    expect(composed.sameDoorRoutes.poly__place_order?.routes).toEqual(["poly.orders.create"]);
    expect(composed.sameDoorRoutes.core__work_item_update).toBe(SAME_DOOR_ROUTES.core__work_item_update);
    expect(composed.routeOnlyCapabilities["trading.audit"]?.requires.scope).toBe("trading:audit");
    expect(composed.noRouteTwin.poly__sandbox_probe).toBeDefined();
  });

  it("throws when a node reuses a baseline key; it never replaces", () => {
    expect(() => composeAgentRoutes({ sameDoorRoutes: { core__work_item_update: { scope: "x:y", routes: ["a.b"] } } })).toThrow(/ROUTE_COLLISION/);
    expect(() => composeAgentRoutes({ routeOnlyCapabilities: { "knowledge.read": { requires: audit, routes: ["a.b"] } } })).toThrow(/ROUTE_COLLISION/);
    expect(() => composeAgentRoutes({ noRouteTwin: { core__sandbox_shell: "a reason that is long enough" } })).toThrow(/ROUTE_COLLISION/);
  });

  it("throws when a tool is both twinned and exempt, or one route id sits under two entries", () => {
    expect(() =>
      composeAgentRoutes({
        sameDoorRoutes: { poly__x: { scope: trade.scope, routes: ["poly.x"] } },
        noRouteTwin: { poly__x: "a reason that is long enough" },
      })
    ).toThrow(/both twinned|route twin and is also/);
    expect(() => composeAgentRoutes({ sameDoorRoutes: { poly__x: { scope: trade.scope, routes: ["work.items.patch"] } } })).toThrow(/ROUTE_COLLISION: route "work.items.patch"/);
  });
});

describe("buildPermissionCatalog with a node's routes", () => {
  const byId = buildRequiresById([{ id: "poly__place_order", requires: trade }]);

  it("makes a node's route twin and route-only scope askable and declared", () => {
    const catalog = buildPermissionCatalog(byId, nodeRoutes);
    expect(catalog.declaredScopes).toEqual(expect.arrayContaining([trade.scope, audit.scope]));
    expect(catalog.askableScopes).toEqual(expect.arrayContaining([trade.scope, audit.scope]));
    expect(catalog.permissions.map((p) => p.scope)).toEqual(expect.arrayContaining([trade.scope, audit.scope]));
  });

  it("leaves a node tool's scope declared but not askable until a route twins it", () => {
    const catalog = buildPermissionCatalog(byId);
    expect(catalog.declaredScopes).toContain(trade.scope);
    expect(catalog.askableScopes).not.toContain(trade.scope);
  });

  it("throws when one scope is declared twice with different fields, and accepts an identical repeat", () => {
    expect(() =>
      buildPermissionCatalog(buildRequiresById([{ id: "poly__a", requires: trade }, { id: "poly__b", requires: { ...trade, label: "Trade stuff" } }]))
    ).toThrow(/SCOPE_DECLARED_TWICE/);
    expect(() =>
      buildPermissionCatalog(buildRequiresById([{ id: "poly__a", requires: trade }, { id: "poly__b", requires: { ...trade, subject: "admin" } }]))
    ).toThrow(/SCOPE_DECLARED_TWICE/);
    expect(() =>
      buildPermissionCatalog(buildRequiresById([{ id: "poly__a", requires: trade }, { id: "poly__b", requires: { ...trade } }]))
    ).not.toThrow();
  });

  it("throws when a route-only capability redeclares a tool's scope with other fields", () => {
    expect(() =>
      buildPermissionCatalog(byId, { routeOnlyCapabilities: { "trading.other": { requires: { ...trade, description: "Something else" }, routes: ["poly.other"] } } })
    ).toThrow(/SCOPE_DECLARED_TWICE/);
  });
});

describe("createAgentToolAuthority with a node's routes", () => {
  const sql = Object.assign((async () => []) as never, { begin: async (fn: (tx: never) => unknown) => fn((async () => []) as never) }) as unknown as AgentAuthoritySql;
  const make = (routes?: typeof nodeRoutes) =>
    createAgentToolAuthority({
      sql,
      nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tools: [{ id: "poly__place_order", requires: trade }],
      routes,
      graphs: [],
      systemUserIds: [],
    });

  it("lists the node's scopes as askable and lets a signed-in human through its route-only door", async () => {
    const authority = make(nodeRoutes);
    expect(authority.askableScopes).toEqual(expect.arrayContaining([trade.scope, audit.scope]));
    expect(await authority.authorizeRoute({ toolId: "trading.audit", routeId: "poly.audit.list", userId: "u1", via: "session" })).toMatchObject({ decision: "allow" });
  });

  it("denies a route-only door the node never declared", async () => {
    expect(await make().authorizeRoute({ toolId: "trading.audit", routeId: "poly.audit.list", userId: "u1", via: "session" })).toMatchObject({ decision: "deny", reason: "no_requires" });
  });

  it("throws at construction on a collision with the package", () => {
    expect(() => make({ ...nodeRoutes, sameDoorRoutes: { core__schedule_manage: { scope: "x:y", routes: ["q.r"] } } })).toThrow(/ROUTE_COLLISION/);
  });
});

describe("the exported same-door parity suite", () => {
  // The package's own entries stand in as contracts, so only the node's additions are under test here.
  const baseline = [
    ...Object.entries(SAME_DOOR_ROUTES).map(([name, e]) =>
      e.scope === "account:read"
        ? { name, effect: "read_only", requires: { scope: e.scope, kind: "account", subject: "member" } as ToolRequires }
        : { name, effect: "state_change", requires: { scope: e.scope, kind: "node", subject: "member" } as ToolRequires }
    ),
    ...Object.keys(NO_ROUTE_TWIN).map((name) => ({ name, effect: "state_change", requires: { scope: "other:scope", kind: "node", subject: "admin" } as ToolRequires })),
  ];
  const nodeContracts = [
    { name: "poly__place_order", effect: "external_side_effect", requires: trade },
    { name: "poly__sandbox_probe", effect: "state_change", requires: trade },
    { name: "poly__read", effect: "read_only" },
  ];
  const contracts = [...baseline, ...nodeContracts];
  const violations = (routes = composeAgentRoutes(nodeRoutes), set = contracts) => SAME_DOOR_PARITY_RULES.flatMap((r) => r.violations(set, routes, {}).map((v) => `${r.name}: ${v}`));

  it("passes a node's composed set when every writer is twinned or exempt", () => {
    expect(violations()).toEqual([]);
  });

  it("fails a node writer with no twin and no exemption", () => {
    expect(unmappedWriteTools(nodeContracts, {}, {})).toEqual(["poly__place_order", "poly__sandbox_probe"]);
    expect(violations(composeAgentRoutes())).toEqual(expect.arrayContaining([expect.stringContaining("poly__place_order")]));
    expect(violations(composeAgentRoutes({ sameDoorRoutes: nodeRoutes.sameDoorRoutes })).join("\n")).toContain("poly__sandbox_probe");
  });

  it("fails a route-only scope a tool also declares", () => {
    const routes = composeAgentRoutes({ ...nodeRoutes, routeOnlyCapabilities: { "trading.dup": { requires: trade, routes: ["poly.dup"] } } });
    expect(violations(routes).join("\n")).toContain("trading.dup");
  });

  it("lets a node omit only the baseline tools it names as absent, and still checks its own entries", () => {
    const routes = composeAgentRoutes(nodeRoutes);
    const noVcs = contracts.filter((c) => c.name !== "core__vcs_merge_pr");
    const run = (set: typeof contracts, r = routes, absentBaseline: string[] = []) => SAME_DOOR_PARITY_RULES.flatMap((rule) => rule.violations(set, r, { absentBaseline }));
    expect(run(noVcs)).toEqual(["core__vcs_merge_pr"]);
    expect(run(noVcs, routes, ["core__vcs_merge_pr"])).toEqual([]);
    const gone = noVcs.filter((c) => c.name !== "poly__sandbox_probe");
    expect(run(gone, routes, ["core__vcs_merge_pr"])).toContain("poly__sandbox_probe");
    // Naming one absent tool does not waive another baseline tool that went missing.
    expect(run(noVcs.filter((c) => c.name !== "core__sandbox_shell"), routes, ["core__vcs_merge_pr"])).toContain("core__sandbox_shell");
  });

  it("registers one row per rule under the caller's runner", () => {
    const rows: string[] = [];
    runSameDoorParity({
      describe: (_n, fn) => fn(),
      it: (name) => void rows.push(name),
      expect: expect as never,
      contracts,
      routes: composeAgentRoutes(nodeRoutes),
    });
    expect(rows).toEqual(SAME_DOOR_PARITY_RULES.map((r) => r.name));
  });
});
