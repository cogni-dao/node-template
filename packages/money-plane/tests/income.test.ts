// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it } from "vitest";

import { creditPurchaseIncomeReader, takeSnapshot } from "../src/index";

const NOW = new Date("2026-10-26T13:40:00.000Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("creditPurchaseIncomeReader", () => {
  it("sums credited purchases in the trailing 30 days into USD per day and survives the grading floor", async () => {
    const since: Date[] = [];
    const reader = creditPurchaseIncomeReader({
      now: () => NOW,
      query: async (s) => {
        since.push(s);
        return [
          { amountUsdCents: 2000, createdAt: day(1) },
          { amountUsdCents: 1500, createdAt: day(10) },
          { amountUsdCents: 1000, createdAt: day(29) },
          { amountUsdCents: 999, createdAt: day(31) },
          { amountUsdCents: 0, createdAt: day(2) },
        ];
      },
    });
    expect(reader.kind).toBe("income");
    expect(since[0]).toBeUndefined();
    const snap = await takeSnapshot([reader], { timeoutMs: 1000, now: () => NOW });
    expect(since[0]?.toISOString()).toBe(day(30).toISOString());
    const row = snap.rows[0];
    expect(row).toMatchObject({
      plane: "income:credit-purchases",
      label: "Credit purchases",
      kind: "income",
      balance: null,
      currency: "USD",
      runwayDays: null,
      grade: "INFO",
      rail: { kind: "split-inflow", status: "supported" },
      detail: "3 purchases · 45.00 USD in 30d",
      source: "payment_events · CREDITED · trailing 30 days",
    });
    const byIntent = await creditPurchaseIncomeReader({
      now: () => NOW,
      basis: "intent",
      query: async () => [],
    }).read(new AbortController().signal);
    expect(byIntent.source).toContain("by intent time");
    expect(row?.burnPerDay).toBeCloseTo(1.5, 9);
  });
  it("reports a measured zero when there are no purchases and UNKNOWN when the query fails", async () => {
    const zero = await creditPurchaseIncomeReader({ now: () => NOW, query: async () => [] }).read(
      new AbortController().signal
    );
    expect(zero).toMatchObject({ grade: "INFO", burnPerDay: 0, detail: "0 purchases · 0.00 USD in 30d" });
    const failed = await creditPurchaseIncomeReader({
      now: () => NOW,
      query: async () => {
        throw new Error("sensitive-dsn");
      },
    }).read(new AbortController().signal);
    expect(failed).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      detail: "income read failed",
      rail: { kind: "split-inflow" },
    });
    expect(JSON.stringify(failed)).not.toContain("sensitive-dsn");
  });
});
