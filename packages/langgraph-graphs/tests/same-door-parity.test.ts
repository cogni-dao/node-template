// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/langgraph-graphs/tests/same-door-parity`
 * Purpose: SAME_DOOR parity over the shared bundle. The rules are `@cogni-dao/agent-grants/same-door-parity`'s (the suite a node runs over its own composed
 *   set); this file runs them over the package bundle and pins the baseline's own entries.
 * Scope: Contracts from `@cogni/ai-tools` and the map from `@cogni/agent-grants`; no database.
 * Invariants: SAME_DOOR, TOOL_HAS_ROUTE_TWIN
 * Side-effects: none
 */

import { composeAgentRoutes, NO_ROUTE_TWIN, ROUTE_ONLY_CAPABILITIES, SAME_DOOR_ROUTES } from "@cogni/agent-grants";
import { runSameDoorParity, unmappedWriteTools } from "@cogni/agent-grants/same-door-parity";
import { CORE_TOOL_BUNDLE, VCS_TOOL_BUNDLE } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

const contracts = [...CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE].map((t) => t.contract);
const writers = contracts.filter((c) => c.effect !== "read_only");
/** A read tool is gated only when it declares `requires` (an account read, task.5465): it needs a route twin too. */
const gatedReaders = contracts.filter((c) => c.effect === "read_only" && c.requires);

runSameDoorParity({ describe, it, expect, contracts, routes: composeAgentRoutes() });

describe("same-door baseline", () => {
  it("has exactly one gated READ tool, the account credits read", () => {
    expect(gatedReaders.map((c) => c.name)).toEqual(["core__account_credits_read"]);
    expect(SAME_DOOR_ROUTES.core__account_credits_read?.routes).toEqual(["accounts.credits.read", "payments.credits_summary"]);
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

  it("declares the knowledge route-only scopes", () => {
    expect(ROUTE_ONLY_CAPABILITIES["knowledge.contribute"]?.requires).toMatchObject({
      scope: "knowledge:contribute",
      subject: "member",
    });
  });

  it("allowlists knowledge_write (no direct-to-main route) and keeps it out of the route map", () => {
    expect("core__knowledge_write" in NO_ROUTE_TWIN).toBe(true);
    expect("core__knowledge_write" in SAME_DOOR_ROUTES).toBe(false);
  });
});
