// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it } from "vitest";

import { type MoneyPlaneRow, summarize, toUsd } from "../src/index";

const NOW = "2026-10-26T13:40:00.000Z";
const RATE = { pair: "EURUSD", value: 1.1188, source: "ECB" as const, date: "2026-10-26" };
function row(over: Partial<MoneyPlaneRow> & Pick<MoneyPlaneRow, "plane">): MoneyPlaneRow {
  return {
    label: over.plane,
    kind: "usage",
    balance: null,
    currency: "USD",
    burnPerDay: null,
    runwayDays: null,
    grade: "INFO",
    observedAt: NOW,
    sourceObservedAt: NOW,
    freshness: "current",
    ...over,
  };
}

describe("summarize", () => {
  it("sums income and burn in USD, converts EUR, and names the shortest graded runway", () => {
    const rows = [
      row({ plane: "income", kind: "income", burnPerDay: 1.5 }),
      row({ plane: "treasury", label: "DAO treasury", kind: "wallet", currency: "USDC", balance: 74.52 }),
      row({ plane: "akash", label: "Akash", kind: "prepaid", balance: 7.89, burnPerDay: 3.13, runwayDays: 2.52, grade: "RED" }),
      row({ plane: "cherry", label: "Cherry credit", kind: "prepaid", currency: "EUR", balance: 12.4, burnPerDay: 0.3432, runwayDays: 36, grade: "GREEN" }),
      row({ plane: "grafana", burnPerDay: 9.7173 }),
      row({ plane: "domain", kind: "expiry", currency: null, runwayDays: 161, grade: "GREEN" }),
      row({ plane: "unread", grade: "UNKNOWN" }),
    ].map((r) => toUsd(r, [RATE]));
    const summary = summarize({ rows }, { treasuryPlane: "treasury" });
    expect(summary.treasuryUsd).toBe(74.52);
    expect(summary.incomePerDay).toBe(1.5);
    expect(summary.burnPerDay).toBeCloseTo(3.13 + 0.3432 * 1.1188 + 9.7173, 9);
    expect(summary.shortestRunway).toEqual({ days: 2.52, label: "Akash" });
    expect(summary.ratesUsed).toEqual([RATE]);
    expect(summary.unconverted).toEqual([]);
  });
  it("never double counts children under a rollup parent, but uses children when the parent has no burn", () => {
    const akash = row({
      plane: "akash",
      kind: "prepaid",
      balance: 7.89,
      burnPerDay: 3.13,
      children: [
        row({ plane: "akash:poly", burnPerDay: 1.57 }),
        row({ plane: "akash:red", burnPerDay: 1.56 }),
      ],
    });
    const grafana = row({
      plane: "grafana",
      children: [row({ plane: "logs", burnPerDay: 6 }), row({ plane: "metrics", burnPerDay: 4 })],
    });
    const summary = summarize({ rows: [akash, grafana].map((r) => toUsd(r, [])) });
    expect(summary.burnPerDay).toBeCloseTo(3.13 + 10, 9);
    expect(summary.incomePerDay).toBeNull();
    expect(summary.treasuryUsd).toBeNull();
  });
  it("reports an unconverted EUR row instead of guessing, and nulls when nothing is measured", () => {
    const summary = summarize({
      rows: [row({ plane: "cherry", label: "Cherry credit", kind: "prepaid", currency: "EUR", balance: 12.4, burnPerDay: 0.34, grade: "UNKNOWN" })],
    });
    expect(summary.burnPerDay).toBeNull();
    expect(summary.unconverted).toEqual(["Cherry credit"]);
    expect(summary.shortestRunway).toBeNull();
    expect(summarize({ rows: [] })).toEqual({
      treasuryUsd: null,
      incomePerDay: null,
      burnPerDay: null,
      shortestRunway: null,
      ratesUsed: [],
      unconverted: [],
    });
  });
});
