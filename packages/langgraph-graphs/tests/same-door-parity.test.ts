// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/langgraph-graphs/tests/same-door-parity`
 * Purpose: SAME_DOOR parity. Every non-read_only tool contract is mapped to the route(s) that twin it
 *   (`SAME_DOOR_ROUTES`) or is on the documented allowlist (`NO_ROUTE_TWIN`). A new write tool with neither fails here.
 * Scope: Contracts from `@cogni/ai-tools` and the map from `@cogni/agent-grants`; no database.
 * Invariants: SAME_DOOR, TOOL_HAS_ROUTE_TWIN
 * Side-effects: none
 */

import { NO_ROUTE_TWIN, SAME_DOOR_ROUTES } from "@cogni/agent-grants";
import { CORE_TOOL_BUNDLE, VCS_TOOL_BUNDLE } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

const contracts = [...CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE].map((t) => t.contract);
const writers = contracts.filter((c) => c.effect !== "read_only");

/** The check itself, so a test can show it fails on an unmapped write tool. */
export function unmappedWriteTools(
  tools: ReadonlyArray<{ name: string; effect: string }>,
  mapped: Readonly<Record<string, unknown>>,
  allowlisted: Readonly<Record<string, unknown>>
): string[] {
  return tools
    .filter((t) => t.effect !== "read_only" && !(t.name in mapped) && !(t.name in allowlisted))
    .map((t) => t.name);
}

describe("same-door parity", () => {
  it("maps or allowlists every non-read_only tool", () => {
    expect(unmappedWriteTools(writers, SAME_DOOR_ROUTES, NO_ROUTE_TWIN)).toEqual([]);
  });

  it("fails on a new unmapped write tool", () => {
    expect(
      unmappedWriteTools(
        [...writers, { name: "core__brand_new_writer", effect: "state_change" }],
        SAME_DOOR_ROUTES,
        NO_ROUTE_TWIN
      )
    ).toEqual(["core__brand_new_writer"]);
  });

  it("carries the same scope on the route map as on the tool contract", () => {
    for (const c of writers) {
      const mapped = SAME_DOOR_ROUTES[c.name];
      if (mapped) expect(mapped.scope, c.name).toBe(c.requires?.scope);
    }
  });

  it("keeps every mapped tool real and every route list non-empty", () => {
    const names = new Set(contracts.map((c) => c.name));
    for (const [tool, entry] of Object.entries(SAME_DOOR_ROUTES)) {
      expect(names.has(tool), tool).toBe(true);
      expect(entry.routes.length, tool).toBeGreaterThan(0);
    }
  });

  it("allowlists only tools that exist, and none that are also mapped", () => {
    const names = new Set(contracts.map((c) => c.name));
    for (const tool of Object.keys(NO_ROUTE_TWIN)) {
      expect(names.has(tool), tool).toBe(true);
      expect(tool in SAME_DOOR_ROUTES, tool).toBe(false);
    }
    expect(Object.values(NO_ROUTE_TWIN).every((reason) => reason.length > 10)).toBe(true);
  });
});
