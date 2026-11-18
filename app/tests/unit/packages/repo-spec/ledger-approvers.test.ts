// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/ledger-approvers`
 * Purpose: Another node's approvers are read from its raw repo-spec without requiring the whole spec to match this schema.
 * Scope: Pure unit test of `readLedgerApproversFromYaml`.
 * Invariants: APPROVERS_ONLY, MALFORMED_IS_LOUD.
 * Side-effects: none
 * Links: packages/repo-spec/src/ledger-approvers.ts
 * @public
 */

import { readLedgerApproversFromYaml } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

const A = "0x070075F1389Ae1182aBac722B36CA12285d0c949";

describe("readLedgerApproversFromYaml", () => {
  it("reads the approvers of a fork whose repo-spec carries a retired field", () => {
    const yaml = `node_id: "x"\ndeployment:\n  services:\n    - name: app\n      secret_refs: [OLD]\nactivity_ledger:\n  approvers:\n    - "${A}"\n`;
    expect(readLedgerApproversFromYaml(yaml)).toEqual([A.toLowerCase()]);
  });

  it("returns [] when the list is absent", () => {
    expect(readLedgerApproversFromYaml("node_id: x\n")).toEqual([]);
  });

  it("throws malformed_spec for a bad wallet, a non-list, or unparseable YAML", () => {
    expect(() => readLedgerApproversFromYaml("activity_ledger:\n  approvers: [\"0x123\"]\n")).toThrow("malformed_spec");
    expect(() => readLedgerApproversFromYaml("activity_ledger:\n  approvers: nope\n")).toThrow("malformed_spec");
    expect(() => readLedgerApproversFromYaml("a: [\n")).toThrow("malformed_spec");
  });
});
