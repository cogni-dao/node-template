// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/requires-guard`
 * Purpose: CI guard — every non-read_only tool contract declares `requires`.
 * Invariants: SCOPED_TOOL_NEEDS_PRINCIPAL is only enforceable if each state-changing tool names its scope.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import { CORE_TOOL_BUNDLE, VCS_TOOL_BUNDLE } from "../src/catalog";
import type { ToolContract } from "../src/types";

type AnyContract = ToolContract<string, unknown, unknown, unknown>;

/** The guard itself, reusable by a node for its own bundle. */
export function contractsMissingRequires(
  contracts: readonly Pick<AnyContract, "name" | "effect" | "requires">[]
): string[] {
  return contracts
    .filter((c) => c.effect !== "read_only" && c.requires === undefined)
    .map((c) => c.name);
}

describe("requires guard", () => {
  const contracts = [...CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE].map(
    (t) => t.contract as AnyContract
  );

  it("passes for every real contract", () => {
    expect(contractsMissingRequires(contracts)).toEqual([]);
  });

  it("covers exactly the ten state-changing tools", () => {
    expect(
      contracts
        .filter((c) => c.effect !== "read_only")
        .map((c) => c.name)
        .sort()
    ).toEqual(
      [
        "core__edo_decide",
        "core__edo_hypothesize",
        "core__edo_record_outcome",
        "core__knowledge_write",
        "core__metric_compute",
        "core__schedule_manage",
        "core__vcs_create_branch",
        "core__vcs_flight_candidate",
        "core__vcs_merge_pr",
        "core__work_item_transition",
      ].sort()
    );
  });

  it("fails for a state-changing contract with no requires", () => {
    expect(
      contractsMissingRequires([
        { name: "core__new_writer", effect: "state_change" },
        { name: "core__new_effect", effect: "external_side_effect" },
        { name: "core__new_reader", effect: "read_only" },
      ])
    ).toEqual(["core__new_writer", "core__new_effect"]);
  });

  it("never puts requires on a read_only tool", () => {
    expect(
      contracts.filter((c) => c.effect === "read_only" && c.requires)
    ).toEqual([]);
  });

  it("declares the intended scope map", () => {
    const by = Object.fromEntries(contracts.map((c) => [c.name, c.requires]));
    expect(by.core__knowledge_write).toMatchObject({ scope: "knowledge:write", kind: "node", subject: "admin" });
    expect(by.core__work_item_transition).toMatchObject({ scope: "work_item:transition", kind: "node", subject: "member" });
    expect(by.core__schedule_manage).toMatchObject({ scope: "schedule:manage", kind: "own", subject: "member" });
    expect(by.core__edo_decide?.scope).toBe("edo:write");
    expect(by.core__vcs_merge_pr?.subject).toBe("admin");
  });

  it("gives every requires a plain-language label, with no scope string, id, path, tool name or the word job", () => {
    for (const c of contracts.filter((c) => c.requires)) {
      const r = c.requires!;
      expect(r.label.length, c.name).toBeGreaterThan(8);
      expect(r.label, c.name).not.toMatch(/[:/_]|\bcore\b|http|token|curl|\bjobs?\b/i);
    }
  });

  it("gives every requires one plain description line, with no scope string, path or the word job, and one per scope", () => {
    const seen = new Map<string, string>();
    for (const c of contracts.filter((c) => c.requires)) {
      const r = c.requires!;
      expect(r.description.length, c.name).toBeGreaterThan(15);
      expect(r.description.length, c.name).toBeLessThan(90);
      expect(r.description, c.name).not.toMatch(/[:/_]|\bcore\b|http|token|curl|\bjobs?\b/i);
      expect(seen.get(r.scope) ?? r.description, r.scope).toBe(r.description);
      seen.set(r.scope, r.description);
    }
  });

  it("uses one label per scope, so the table never shows two names for one permission", () => {
    const seen = new Map<string, string>();
    for (const c of contracts.filter((c) => c.requires)) {
      const r = c.requires!;
      const key = r.label;
      expect(seen.get(r.scope) ?? key, r.scope).toBe(key);
      seen.set(r.scope, key);
    }
  });
});
