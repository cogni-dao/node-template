// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/node-tool-bundle`
 * Purpose: ONE_COMPOSED_BUNDLE and NODE_ADDS_ONLY at the composition root. This is the CI check a node runs on ITS composed set: the same-door parity
 *   suite and the `requires` guard over `NODE_TOOL_BUNDLE` and `nodeExtensions.routes`. It also shows a node tool's `requires` reaching the permission catalog.
 * Scope: Pure composition; no database, no network. Node-template declares nothing in `node-extensions.ts`, so its composed set is the baseline.
 * Side-effects: none
 */

import { composeAgentRoutes } from "@cogni/agent-grants";
import { buildPermissionCatalog, buildRequiresById } from "@cogni/agent-grants/host";
import { runSameDoorParity } from "@cogni/agent-grants/same-door-parity";
import {
  CORE_TOOL_BUNDLE,
  contractsMissingRequires,
  type CatalogBoundTool,
  readOnlyContractsWithNonAccountRequires,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { NODE_LOCAL_TOOL_BUNDLE } from "@/bootstrap/ai/secret-probe";
import {
  composeToolBundle,
  extensionToolBindings,
  NODE_TOOL_BUNDLE,
} from "@/bootstrap/ai/tool-bundle";
import { nodeExtensions } from "@/node-extensions";

const contracts = NODE_TOOL_BUNDLE.map((t) => t.contract);

// A node's own governed tool, as a node would declare it in node-extensions.ts.
const requires = {
  scope: "trading:place_order",
  kind: "node",
  subject: "member",
  label: "Place trades",
  description: "Place orders from the node's own wallet",
} as const;
const placeOrder = {
  contract: {
    name: "node__place_order",
    description: "Place one order.",
    effect: "state_change",
    requires,
    inputSchema: z.object({ market: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    redact: (o: { ok: boolean }) => o,
    allowlist: ["ok"],
  },
  implementation: { execute: async () => ({ ok: true }) },
} as unknown as CatalogBoundTool;

describe("the node's composed set (node-template baseline)", () => {
  it("declares nothing in node-extensions.ts, so the bundle is core plus the node-local tools", () => {
    expect(nodeExtensions).toEqual({});
    expect(NODE_TOOL_BUNDLE).toEqual([...CORE_TOOL_BUNDLE, ...NODE_LOCAL_TOOL_BUNDLE]);
  });

  // The operator's VCS tools are in the package's exemption list but not in a node's bundle, hence baselineMayBeAbsent.
  runSameDoorParity({ describe, it, expect, contracts, routes: composeAgentRoutes(nodeExtensions.routes), options: { baselineMayBeAbsent: true } });

  it("passes the requires guard", () => {
    expect(contractsMissingRequires(contracts)).toEqual([]);
    expect(readOnlyContractsWithNonAccountRequires(contracts)).toEqual([]);
  });
});

describe("a node that declares a tool and its route twin", () => {
  const ext = {
    tools: [placeOrder],
    routes: { sameDoorRoutes: { node__place_order: { scope: requires.scope, routes: ["node.orders.create"] } } },
  };

  it("joins the one bundle, with its implementation bound and its requires in the permission catalog", () => {
    const bundle = composeToolBundle(ext);
    expect(bundle.map((t) => t.contract.name)).toContain("node__place_order");
    expect(Object.keys(extensionToolBindings(ext))).toEqual(["node__place_order"]);
    const catalog = buildPermissionCatalog(
      buildRequiresById(bundle.map((t) => ({ id: t.contract.name, requires: t.contract.requires }))),
      ext.routes
    );
    expect(catalog.declaredScopes).toContain("trading:place_order");
    expect(catalog.askableScopes).toContain("trading:place_order");
  });

  // The node's parity suite over its composed set.
  runSameDoorParity({
    describe,
    it,
    expect,
    contracts: composeToolBundle(ext).map((t) => t.contract),
    routes: composeAgentRoutes(ext.routes),
    options: { baselineMayBeAbsent: true },
  });

  it("throws when a node declares a tool id the bundle already holds", () => {
    expect(() => composeToolBundle({ tools: [placeOrder, placeOrder] })).toThrow(/TOOL_ID_DUPLICATE/);
    expect(() => composeToolBundle({ tools: [CORE_TOOL_BUNDLE[0] as CatalogBoundTool] })).toThrow(/TOOL_ID_DUPLICATE/);
  });
});
