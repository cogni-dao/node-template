// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it } from "vitest";
import {
  governanceScheduleId,
  isLegacyFlatGovernanceScheduleId,
  isOperatorOwnedGovernanceCharter,
  isOwnGovernanceScheduleId,
} from "../src/index.js";

describe("governance schedule ownership", () => {
  const node = "11111111-1111-4111-8111-111111111111";
  it("scopes and normalizes IDs, including operator ledger IDs", () => {
    expect(governanceScheduleId(node, "COMMUNITY")).toBe(
      `governance:${node}:community`
    );
    expect(governanceScheduleId(node, "LEDGER_INGEST")).toBe(
      `governance:${node}:ledger_ingest`
    );
  });
  it("never lets a node prune ledger, flat, sibling or empty IDs", () => {
    expect(
      isOwnGovernanceScheduleId(node, `governance:${node}:community`)
    ).toBe(true);
    for (const id of [
      `governance:${node}:ledger_ingest`,
      `governance:${node}:LEDGER_INGEST`,
      `governance:${node}:LeDgEr_InGeSt`,
      `governance:${node}:`,
      "governance:community",
      "governance:other:community",
    ]) {
      expect(isOwnGovernanceScheduleId(node, id)).toBe(false);
    }
  });
  it("identifies operator-owned charter regardless of case", () => {
    for (const charter of ["ledger_ingest", "LEDGER_INGEST", "LeDgEr_InGeSt"])
      expect(isOperatorOwnedGovernanceCharter(charter)).toBe(true);
    expect(isOperatorOwnedGovernanceCharter("community")).toBe(false);
  });
  it("identifies legacy flat IDs independently of scoped IDs", () => {
    expect(isLegacyFlatGovernanceScheduleId("governance:ledger_ingest")).toBe(
      true
    );
    expect(
      isLegacyFlatGovernanceScheduleId(`governance:${node}:community`)
    ).toBe(false);
    expect(isLegacyFlatGovernanceScheduleId("other:community")).toBe(false);
  });
});
