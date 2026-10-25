// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: money-plane/tests/summarize
 * Purpose: Prove native contract and measured cost cohorts without custody or period mixing.
 * Scope: Public pure summary API; no IO.
 * Invariants: Exact addition, explicit attribution, partial evidence and conservative age.
 * Side-effects: none
 * Links: src/summarize.ts
 * @internal
 */
import { describe, expect, it } from "vitest";
import { type CostRateEvidence, summarizeCostRates } from "../src/index";

const evidence = (
  sourceId: string,
  amount: string | null,
  over: Partial<CostRateEvidence> = {}
): CostRateEvidence => ({
  sourceId,
  ownerId: "operator",
  scopeId: "operator-fleet",
  instrumentId: "akash:uact",
  basis: { kind: "contract", active: true },
  rate: { amount, currency: "uact", per: "block" },
  sourceObservedAt: null,
  partial: false,
  ...over,
});

describe("summarizeCostRates", () => {
  it("adds existing active contract aggregates exactly despite unknown age; excludes closed and identical duplicates", () => {
    const a = evidence("node-a", "2");
    const summary = summarizeCostRates([
      a,
      evidence("node-b", "3"),
      a,
      evidence("closed", "90", { basis: { kind: "contract", active: false } }),
    ]);
    expect(summary).toEqual({
      unattributedCount: 0,
      cohorts: [
        {
          ownerId: "operator",
          scopeId: "operator-fleet",
          instrumentId: "akash:uact",
          basis: { kind: "contract" },
          rate: { amount: "5", currency: "uact", per: "block" },
          partial: false,
          oldestObservedAt: null,
          ageUnknown: true,
        },
      ],
    });
  });
  it("separates owner, scope, instrument, currency, unit, basis and measured window", () => {
    const window = {
      kind: "measured" as const,
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-02T00:00:00Z",
    };
    const rows = [
      evidence("a", "2"),
      evidence("b", "3"),
      evidence("owner", "7", { ownerId: "other" }),
      evidence("scope", "7", { scopeId: "other" }),
      evidence("asset", "7", { instrumentId: "other-credit" }),
      evidence("currency", "7", {
        rate: { amount: "7", currency: "EUR", per: "block" },
      }),
      evidence("unit", "7", {
        rate: { amount: "7", currency: "uact", per: "day" },
      }),
      evidence("measured-a", "2", {
        basis: window,
        rate: { amount: "2", currency: "USD", per: "day" },
      }),
      evidence("measured-b", "3", {
        basis: window,
        rate: { amount: "3", currency: "USD", per: "day" },
      }),
      evidence("window", "7", {
        basis: { ...window, end: "2026-10-03T00:00:00Z" },
      }),
    ];
    const result = summarizeCostRates(rows);
    expect(result.cohorts).toHaveLength(8);
    expect(result.cohorts.filter((c) => c.rate.amount === "5")).toHaveLength(2);
    expect(result).not.toHaveProperty("runway");
  });
  it("retains oldest age and known partial sum; missing does not become zero", () => {
    const result = summarizeCostRates([
      evidence("old", "0.1", { sourceObservedAt: "2026-10-01T00:00:00Z" }),
      evidence("fresh", "0.2", { sourceObservedAt: "2026-10-25T00:00:00Z" }),
      evidence("missing", null),
    ]).cohorts[0];
    expect(result).toMatchObject({
      rate: { amount: "0.3" },
      partial: true,
      oldestObservedAt: "2026-10-01T00:00:00.000Z",
      ageUnknown: true,
    });
    expect(
      summarizeCostRates([evidence("missing", null)]).cohorts[0]?.rate.amount
    ).toBeNull();
    expect(
      summarizeCostRates([evidence("zero", "0")]).cohorts[0]?.rate.amount
    ).toBe("0");
  });
  it("rejects unbounded, invalid, negative and conflicting source evidence without erasing known members", () => {
    const invalid = ["NaN", "Infinity", "-1", "1e401", "1".repeat(257), "bad"];
    const result = summarizeCostRates([
      evidence("good", "0.000000000000000123"),
      evidence("tiny", "1e-18"),
      ...invalid.map((value, i) => evidence(`bad-${i}`, value)),
      evidence("conflict", "100"),
      evidence("conflict", "200"),
      evidence("missing-owner", "999", { ownerId: null }),
      evidence("invalid-window", "999", {
        basis: { kind: "measured", start: "bad", end: "bad" },
      }),
    ]);
    expect(result.unattributedCount).toBe(2);
    expect(result.cohorts[0]).toMatchObject({
      rate: { amount: "0.000000000000000124" },
      partial: true,
    });
  });
  it("normalizes equal measured instants and does not freshen old or missing evidence", () => {
    const base = {
      kind: "measured" as const,
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-02T00:00:00Z",
    };
    const result = summarizeCostRates([
      evidence("a", "2", {
        basis: base,
        sourceObservedAt: "2026-10-02T00:00:00Z",
      }),
      evidence("b", "3", {
        basis: { ...base, start: "2026-10-01T00:00:00.000Z" },
        sourceObservedAt: "invalid",
      }),
    ]);
    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]).toMatchObject({
      rate: { amount: "5" },
      ageUnknown: true,
    });
    expect(summarizeCostRates([])).toEqual({
      cohorts: [],
      unattributedCount: 0,
    });
  });
});
