// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/same-door-parity`
 * Purpose: The SAME_DOOR parity suite, exported so a node runs it over ITS composed tool set and ITS composed routes (`composeAgentRoutes`), not only the
 *   package's. Every non-read_only tool is twinned by a route or exempt with a reason; a gated read tool is twinned with the same scope; every route-only
 *   scope is one no tool already declares.
 * Scope: Pure rules over plain `{ name, effect, requires }` records, so this file imports nothing from ai-tools, and a runner that takes vitest's `describe`, `it`
 *   and `expect` from the caller (the package imports no test runner). No database.
 * Invariants: TOOL_HAS_ROUTE_TWIN, SAME_DOOR (one scope on the tool and on its route twin).
 * Side-effects: none
 * @beta
 */

import { type ComposedRoutes, NO_ROUTE_TWIN, SAME_DOOR_ROUTES } from "./same-door";
import type { ToolRequires } from "./types";

/** What the parity rules read of a tool contract. A node maps its contracts to this shape (an ai-tools contract already has it).
 * @beta
 */
export interface ParityContract {
  readonly name: string;
  readonly effect: string;
  readonly requires?: ToolRequires | undefined;
}

/** A rule returns the offending names; an empty list is a pass.
 * @beta
 */
export interface ParityRule {
  readonly name: string;
  readonly violations: (contracts: readonly ParityContract[], routes: ComposedRoutes, options: ParityOptions) => string[];
}

/** @beta */
export interface ParityOptions {
  /**
   * The package baseline names tools a given node may not carry (the operator's VCS tools). Each id listed here may be missing from `contracts`; any other baseline
   * or node entry must be a real tool. Absent (the package's own run over every shared bundle): every entry must be a real tool.
   */
  readonly absentBaseline?: readonly string[] | undefined;
}

const isAbsentOk = (tool: string, options: ParityOptions) =>
  (options.absentBaseline ?? []).includes(tool) && (tool in SAME_DOOR_ROUTES || tool in NO_ROUTE_TWIN);

/** The tools that change state (or have an outside effect) and are neither twinned nor exempt. Exported so a test can show the check fails on a new tool.
 * @beta
 */
export function unmappedWriteTools(
  tools: ReadonlyArray<{ name: string; effect: string }>,
  mapped: Readonly<Record<string, unknown>>,
  allowlisted: Readonly<Record<string, unknown>>
): string[] {
  return tools
    .filter((t) => t.effect !== "read_only" && !(t.name in mapped) && !(t.name in allowlisted))
    .map((t) => t.name);
}

const isGatedReader = (c: ParityContract) => c.effect === "read_only" && c.requires !== undefined;

/** @beta */
export const SAME_DOOR_PARITY_RULES: readonly ParityRule[] = [
  {
    name: "maps or allowlists every non-read_only tool",
    violations: (contracts, routes) => unmappedWriteTools(contracts, routes.sameDoorRoutes, routes.noRouteTwin),
  },
  {
    name: "maps every gated READ tool (an account read) to its route twin with the same scope and an account kind",
    violations: (contracts, routes) =>
      contracts
        .filter(isGatedReader)
        .filter(
          (c) =>
            c.requires?.kind !== "account" ||
            routes.sameDoorRoutes[c.name]?.scope !== c.requires.scope ||
            c.name in routes.noRouteTwin
        )
        .map((c) => c.name),
  },
  {
    name: "carries the same scope on the route map as on the tool contract",
    violations: (contracts, routes) =>
      contracts.filter((c) => routes.sameDoorRoutes[c.name] && routes.sameDoorRoutes[c.name]?.scope !== c.requires?.scope).map((c) => c.name),
  },
  {
    name: "keeps every mapped tool real and every route list non-empty",
    violations: (contracts, routes, options) => {
      const names = new Set(contracts.map((c) => c.name));
      return Object.entries(routes.sameDoorRoutes)
        .filter(([tool, entry]) => (!names.has(tool) && !isAbsentOk(tool, options)) || entry.routes.length === 0)
        .map(([tool]) => tool);
    },
  },
  {
    name: "allowlists only tools that exist, with a reason, and none that are also mapped",
    violations: (contracts, routes, options) => {
      const names = new Set(contracts.map((c) => c.name));
      return Object.entries(routes.noRouteTwin)
        .filter(([tool, reason]) => (!names.has(tool) && !isAbsentOk(tool, options)) || tool in routes.sameDoorRoutes || reason.length <= 10)
        .map(([tool]) => tool);
    },
  },
  {
    name: "declares each route-only capability once, with a scope no tool uses, routes, and a member or admin subject",
    violations: (contracts, routes) => {
      const toolScopes = new Set(contracts.flatMap((c) => (c.requires ? [c.requires.scope] : [])));
      return Object.entries(routes.routeOnlyCapabilities)
        .filter(
          ([, cap]) =>
            toolScopes.has(cap.requires.scope) ||
            cap.routes.length === 0 ||
            (cap.requires.subject !== "member" && cap.requires.subject !== "admin")
        )
        .map(([id]) => id);
    },
  },
];

// biome-ignore lint/suspicious/noExplicitAny: structural match for vitest's `expect`
type Expect = (value: unknown) => any;

/** @beta */
export interface SameDoorParityHarness {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void) => void;
  expect: Expect;
  /** The node's composed tool contracts (the bundle the tool source, the executor and the catalog all read). */
  contracts: readonly ParityContract[];
  /** `composeAgentRoutes(nodeExtensions.routes)`. */
  routes: ComposedRoutes;
  readonly options?: ParityOptions | undefined;
}

/** Register one row per rule over the node's composed set. A failing row lists the offending tool or capability names.
 * @beta
 */
export function runSameDoorParity(h: SameDoorParityHarness): void {
  h.describe("same-door parity", () => {
    for (const rule of SAME_DOOR_PARITY_RULES)
      h.it(rule.name, () => {
        h.expect(rule.violations(h.contracts, h.routes, h.options ?? {})).toEqual([]);
      });
  });
}
