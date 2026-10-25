// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `money-plane/tests/summarize`
 * Purpose: Prove native subtotal precision, separation and partial evidence.
 * Scope: Pure reporting projection; no IO.
 * Invariants: No FX, custody mixing, fabricated zero, or runway totals.
 * Side-effects: none
 * Links: src/summarize.ts
 * @internal
 */
import { describe, expect, it } from "vitest";
import { type MoneyPlaneRow, summarizeRows } from "../src/index";

const row = (over: Partial<MoneyPlaneRow>): MoneyPlaneRow => ({
  plane: "source",
  label: "Source",
  kind: "prepaid",
  balance: null,
  currency: "USD",
  burnPerDay: null,
  runwayDays: null,
  grade: "UNKNOWN",
  observedAt: "2026-10-25T00:00:00Z",
  sourceObservedAt: "2026-10-25T00:00:00Z",
  freshness: "current",
  ...over,
});

describe("summarizeRows", () => {
  it("adds decimal source values without floating point accumulation and preserves signed tiny balances", () => {
    const result = summarizeRows([
      row({ balance: 0.1 }),
      row({ balance: 0.2 }),
      row({ balance: -0.4 }),
      row({ balance: 1e-7 }),
    ]);
    expect(result.prepaid).toEqual({
      amounts: [{ amount: "-0.0999999", currency: "USD" }],
      partial: false,
    });
  });
  it("keeps wallets, credits, native currencies and rate periods separate", () => {
    const result = summarizeRows([
      row({ kind: "wallet", balance: 20, currency: "USDC" }),
      row({ balance: 12, currency: "USD", burnPerDay: 0.2 }),
      row({
        balance: 4,
        currency: "EUR",
        nativeRate: {
          amount: "0.000000000000000123",
          currency: "AKT",
          per: "block",
        },
        burnPerDay: 99,
      }),
      row({
        kind: "fixed",
        nativeRate: { amount: "5", currency: "USD", per: "month" },
        cumulativeVendorTransfer: {
          amount: "100000000000000000000.001",
          currency: "uact",
        },
      }),
      row({
        kind: "usage",
        nativeRate: {
          amount: "0.000000000000000001",
          currency: "AKT",
          per: "block",
        },
        cumulativeVendorTransfer: { amount: "0.009", currency: "uact" },
      }),
    ]);
    expect(result.wallets.amounts).toEqual([
      { amount: "20", currency: "USDC" },
    ]);
    expect(result.prepaid.amounts).toEqual([
      { amount: "4", currency: "EUR" },
      { amount: "12", currency: "USD" },
    ]);
    expect(result.burn.rates).toEqual([
      { amount: "0.000000000000000124", currency: "AKT", per: "block" },
      { amount: "0.2", currency: "USD", per: "day" },
      { amount: "5", currency: "USD", per: "month" },
    ]);
    expect(result.paid.amounts).toEqual([
      { amount: "100000000000000000000.01", currency: "uact" },
    ]);
  });
  it("keeps missing evidence empty and marks known subtotals partial", () => {
    expect(
      summarizeRows([row({ kind: "wallet", currency: null })]).wallets
    ).toEqual({ amounts: [], partial: true });
    const result = summarizeRows([
      row({ balance: 3 }),
      row({ balance: null }),
      row({ balance: 2, freshness: "stale" }),
    ]);
    expect(result.prepaid).toEqual({
      amounts: [{ amount: "5", currency: "USD" }],
      partial: true,
    });
    expect(result.burn).toEqual({ rates: [], partial: true });
    expect(result.paid).toEqual({ amounts: [], partial: true });
  });
  it("rejects malformed/nonfinite measurements without treating them as zero", () => {
    const result = summarizeRows([
      row({
        balance: Infinity,
        burnPerDay: NaN,
        cumulativeVendorTransfer: { amount: "bad", currency: "USD" },
      }),
    ]);
    expect(result.prepaid).toEqual({ amounts: [], partial: true });
    expect(result.paid).toEqual({ amounts: [], partial: true });
  });
  it("preserves measured zero and does not invent a total runway", () => {
    const result = summarizeRows([row({ balance: 0, burnPerDay: 0 })]);
    expect(result.prepaid).toEqual({
      amounts: [{ amount: "0", currency: "USD" }],
      partial: false,
    });
    expect(result.burn).toEqual({
      rates: [{ amount: "0", currency: "USD", per: "day" }],
      partial: false,
    });
    expect(result).not.toHaveProperty("runway");
  });
});
