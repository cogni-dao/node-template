// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `money-plane/summarize`
 * Purpose: Native reporting subtotals shared by node-owned financial tables.
 * Scope: Pure projection of already deduplicated account rows; no conversion or ledger writes.
 * Invariants: Currency, custody kind and rate period stay separate; missing data is partial, never zero.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */
import type { MoneyPlaneRow, NativeAmount, NativeRate } from "./types";

export interface AmountSummary {
  amounts: NativeAmount[];
  partial: boolean;
}
export interface RateSummary {
  rates: NativeRate[];
  partial: boolean;
}
export interface MoneyPlaneSummary {
  wallets: AmountSummary;
  prepaid: AmountSummary;
  burn: RateSummary;
  paid: AmountSummary;
}

interface Decimal {
  coefficient: bigint;
  scale: number;
}

/** Existing compute-cost coefficient/scale technique, extended to signed finite display values. */
function decimal(value: string | number): Decimal | null {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const text = String(value);
  if (text.length > 256) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 400) return null;
  const fraction = match[3] ?? "";
  const scale = fraction.length - exponent;
  const coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    scale,
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
  };
}

function display(value: Decimal): string {
  const sign = value.coefficient < 0n ? "-" : "";
  const digits = (
    value.coefficient < 0n ? -value.coefficient : value.coefficient
  )
    .toString()
    .padStart(value.scale + 1, "0");
  if (!value.scale) return `${sign}${digits}`;
  const fraction = digits.slice(-value.scale).replace(/0+$/, "");
  return `${sign}${digits.slice(0, -value.scale)}${fraction ? `.${fraction}` : ""}`;
}

export function summarizeRows(
  rows: readonly MoneyPlaneRow[]
): MoneyPlaneSummary {
  const result: MoneyPlaneSummary = {
    wallets: { amounts: [], partial: false },
    prepaid: { amounts: [], partial: false },
    burn: { rates: [], partial: false },
    paid: { amounts: [], partial: false },
  };
  const totals = {
    wallets: new Map<string, Decimal>(),
    prepaid: new Map<string, Decimal>(),
    burn: new Map<string, Decimal>(),
    paid: new Map<string, Decimal>(),
  };
  const rateKeys = new Map<
    string,
    { currency: string; per: NativeRate["per"] }
  >();
  function include(
    bucket: keyof typeof totals,
    row: MoneyPlaneRow,
    amount: string | number | null | undefined,
    currency: string | null | undefined,
    per?: NativeRate["per"]
  ) {
    const value = amount == null ? null : decimal(amount);
    if (
      !value ||
      !currency ||
      (bucket !== "prepaid" && value.coefficient < 0n)
    ) {
      result[bucket].partial = true;
      return;
    }
    const key = per ? JSON.stringify([currency, per]) : currency;
    const map = totals[bucket];
    map.set(key, add(map.get(key) ?? { coefficient: 0n, scale: 0 }, value));
    if (per) rateKeys.set(key, { currency, per });
    if (
      row.freshness !== "current" ||
      !row.sourceObservedAt ||
      !Number.isFinite(Date.parse(row.sourceObservedAt))
    )
      result[bucket].partial = true;
  }
  for (const row of rows) {
    if (row.kind === "wallet")
      include("wallets", row, row.balance, row.currency);
    if (row.kind === "prepaid")
      include("prepaid", row, row.balance, row.currency);
    if (row.kind === "wallet" || row.kind === "expiry") continue;
    if (row.nativeRate)
      include(
        "burn",
        row,
        row.nativeRate.amount,
        row.nativeRate.currency,
        row.nativeRate.per
      );
    else include("burn", row, row.burnPerDay, row.currency, "day");
    include(
      "paid",
      row,
      row.cumulativeVendorTransfer?.amount,
      row.cumulativeVendorTransfer?.currency
    );
  }
  for (const bucket of ["wallets", "prepaid", "paid"] as const) {
    result[bucket].amounts = [...totals[bucket]]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, value]) => ({ currency, amount: display(value) }));
  }
  result.burn.rates = [...totals.burn]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => {
      const rate = rateKeys.get(key);
      return rate ? [{ ...rate, amount: display(value) }] : [];
    });
  return result;
}
