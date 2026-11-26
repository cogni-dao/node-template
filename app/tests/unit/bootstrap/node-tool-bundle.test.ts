// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/node-tool-bundle`
 * Purpose: ONE_COMPOSED_BUNDLE and NODE_ADDS_ONLY at the composition root. This is the CI check a node runs on ITS composed set: the same-door parity
 *   suite and the `requires` guard over the composed bundle and `nodeExtensions.routes`, the permission catalog over the real bundle, and a source scan that the
 *   container and the executor read the one bundle. It also shows a node tool's `requires` reaching the catalog, and a tool factory receiving host services.
 * Scope: Pure composition; no database, no network. Node-template declares nothing in `node-extensions.ts`, so its composed set is the baseline.
 * Side-effects: filesystem reads
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

import { defineNodeExtensions, type ToolHost } from "@/bootstrap/ai/node-extensions-host";
import { NODE_LOCAL_TOOL_BUNDLE } from "@/bootstrap/ai/secret-probe";
import { composeToolBundle } from "@/bootstrap/ai/tool-bundle";
import { nodeExtensions } from "@/node-extensions";

const host = { sentinel: "host" } as unknown as ToolHost;
const { bundle } = composeToolBundle(nodeExtensions, host);
const contracts = bundle.map((t) => t.contract);
const records = bundle.map((t) => ({ id: t.contract.name, requires: t.contract.requires }));
/** Baseline exemptions for tools only the operator composes (VCS_TOOL_BUNDLE). Any other missing baseline tool fails parity. */
const OPERATOR_ONLY = ["core__vcs_create_branch", "core__vcs_flight_candidate", "core__vcs_merge_pr"];

// A node's own governed tool, as a node would declare it in node-extensions.ts.
const requires = {
  scope: "trading:place_order",
  kind: "node",
  subject: "member",
  label: "Place trades",
  description: "Place orders from the node's own wallet",
} as const;
const placeOrder = (wallet?: unknown) =>
  ({
    contract: {
      name: "poly__place_order",
      description: "Place one order.",
      effect: "state_change",
      requires,
      inputSchema: z.object({ market: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      redact: (o: { ok: boolean }) => o,
      allowlist: ["ok"],
    },
    implementation: { execute: async () => ({ ok: true, wallet }) },
  }) as unknown as CatalogBoundTool;

describe("the node's composed set (node-template baseline)", () => {
  it("declares nothing in node-extensions.ts, so the bundle is core plus the node-local tools", () => {
    expect(nodeExtensions).toEqual({});
    expect(bundle).toEqual([...CORE_TOOL_BUNDLE, ...NODE_LOCAL_TOOL_BUNDLE]);
  });

  // The operator's VCS tools are in the package's exemption list but not in a node's bundle, hence the explicit absent list.
  runSameDoorParity({ describe, it, expect, contracts, routes: composeAgentRoutes(nodeExtensions.routes), options: { absentBaseline: OPERATOR_ONLY } });

  it("builds the permission catalog over the real bundle and routes, so a scope clash fails in the node's own CI", () => {
    const catalog = buildPermissionCatalog(buildRequiresById(records), nodeExtensions.routes);
    expect(catalog.declaredScopes).toEqual(expect.arrayContaining(["work_item:transition", "knowledge:contribute"]));
    expect(catalog.askableScopes.length).toBeGreaterThan(0);
  });

  it("is built once by the container and read from it by the executor, never rebuilt from CORE_TOOL_BUNDLE (the container.ts:1299 regression)", () => {
    const read = (file: string) => readFileSync(resolve(__dirname, "../../../src/bootstrap", file), "utf8");
    const container = read("container.ts");
    const executor = read("graph-executor.factory.ts");
    expect(container).not.toMatch(/CORE_TOOL_BUNDLE/);
    expect(executor).not.toMatch(/CORE_TOOL_BUNDLE/);
    expect(container).toMatch(/composeToolBundle\(/);
    expect(container).toMatch(/toolBundle,\n\t\troutes: nodeExtensions\.routes/);
    expect(executor).toMatch(/container\.toolBundle/);
    // No spread merge of tool bindings.
    expect(container).not.toMatch(/\.\.\.NODE_LOCAL_TOOL_BINDINGS/);
  });

  it("passes the requires guard", () => {
    expect(contractsMissingRequires(contracts)).toEqual([]);
    expect(readOnlyContractsWithNonAccountRequires(contracts)).toEqual([]);
  });
});

describe("a node that declares a tool factory and its route twin", () => {
  let received: unknown;
  const ext = defineNodeExtensions({
    tools: (h) => {
      received = h;
      return [placeOrder((h as unknown as { sentinel: string }).sentinel)];
    },
    routes: { sameDoorRoutes: { poly__place_order: { scope: requires.scope, routes: ["poly.orders.create"] } } },
  });
  const composed = composeToolBundle(ext, host);

  it("hands the factory the host's services, and joins the one bundle with its implementation bound and its requires in the permission catalog", async () => {
    expect(received).toBe(host);
    expect(composed.bundle.map((t) => t.contract.name)).toContain("poly__place_order");
    await expect(composed.extensionBindings.poly__place_order?.execute({} as never)).resolves.toMatchObject({ wallet: "host" });
    const catalog = buildPermissionCatalog(
      buildRequiresById(composed.bundle.map((t) => ({ id: t.contract.name, requires: t.contract.requires }))),
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
    contracts: composed.bundle.map((t) => t.contract),
    routes: composeAgentRoutes(ext.routes),
    options: { absentBaseline: OPERATOR_ONLY },
  });

  it("throws on a duplicate id, a core__ id, a missing or mixed prefix", () => {
    const dup = defineNodeExtensions({ tools: () => [placeOrder(), placeOrder()] });
    expect(() => composeToolBundle(dup, host)).toThrow(/TOOL_ID_DUPLICATE: tool "poly__place_order" is declared by/);
    const core = { ...CORE_TOOL_BUNDLE[0] } as CatalogBoundTool;
    expect(() => composeToolBundle(defineNodeExtensions({ tools: () => [core] }), host)).toThrow(/EXTENSION_ID_RESERVED/);
    const bare = placeOrder();
    (bare.contract as { name: string }).name = "place_order";
    expect(() => composeToolBundle(defineNodeExtensions({ tools: () => [bare] }), host)).toThrow(/EXTENSION_ID_PREFIX/);
  });
});
