// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/report`
 * Purpose: The one summary every node shows above its Financials table: treasury, income/day, burn/day and the shortest runway, in USD.
 * Scope: Pure aggregation over a snapshot already projected with `toUsd`. Does not read, grade, or render.
 * Invariants: USD only — a row without a USD projection does not count and is listed in `unconverted`. A parent that
 *   carries burn is the rollup; its children are never added again. Income = Σ income rows; burn = Σ everything else.
 * Side-effects: none
 * Links: ./fx.ts, https://cognidao.org/knowledge/finances-expert
 * @public
 */

import { usdBalance, usdBurn } from "./fx";
import type { MoneyPlaneRow, MoneyPlaneSnapshot, UsdRate } from "./types";

export interface ReportSummary {
  /** The configured treasury's USD balance, or null when unknown or unidentified. */
  treasuryUsd: number | null;
  /** Σ income rows' USD per day; null when no income row is measured. */
  incomePerDay: number | null;
  /** Σ cost rows' USD per day (children not double counted); null when nothing is measured. */
  burnPerDay: number | null;
  /** The graded row that runs out first. */
  shortestRunway: { days: number; label: string } | null;
  /** Rates that were applied to at least one row, for the "EUR→USD 1.1188 · ECB date" line. */
  ratesUsed: UsdRate[];
  /** Labels of rows carrying a non-USD amount that could not be projected. */
  unconverted: string[];
}

export interface SummarizeOptions {
  treasuryPlane?: string | null;
}

function flows(rows: readonly MoneyPlaneRow[]): MoneyPlaneRow[] {
  // A parent with a measured burn is the rollup; otherwise its children carry the detail.
  return rows.flatMap((row) =>
    usdBurn(row) !== undefined || !row.children?.length
      ? [row]
      : flows(row.children)
  );
}

function sumOrNull(values: readonly (number | undefined)[]): number | null {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

function graded(row: MoneyPlaneRow): boolean {
  return (
    (row.grade === "RED" || row.grade === "YELLOW" || row.grade === "GREEN") &&
    row.runwayDays !== null &&
    Number.isFinite(row.runwayDays)
  );
}

function walk(rows: readonly MoneyPlaneRow[]): MoneyPlaneRow[] {
  return rows.flatMap((row) => [row, ...walk(row.children ?? [])]);
}

export function summarize(
  snapshot: Pick<MoneyPlaneSnapshot, "rows">,
  options: SummarizeOptions = {}
): ReportSummary {
  const all = walk(snapshot.rows);
  const treasury = options.treasuryPlane
    ? snapshot.rows.find((row) => row.plane === options.treasuryPlane)
    : undefined;
  const income = flows(snapshot.rows.filter((row) => row.kind === "income"));
  const costs = flows(snapshot.rows.filter((row) => row.kind !== "income"));
  const shortest = all
    .filter(graded)
    .reduce<MoneyPlaneRow | null>(
      (best, row) =>
        best === null || (row.runwayDays ?? 0) < (best.runwayDays ?? 0)
          ? row
          : best,
      null
    );
  const ratesUsed = new Map<string, UsdRate>();
  for (const row of all) if (row.usd?.rate) ratesUsed.set(row.usd.rate.pair, row.usd.rate);
  const unconverted = all
    .filter(
      (row) =>
        row.currency &&
        row.currency !== "USD" &&
        row.currency !== "USDC" &&
        !row.usd &&
        (row.balance !== null || row.burnPerDay !== null)
    )
    .map((row) => row.label);
  return {
    treasuryUsd: treasury ? (usdBalance(treasury) ?? null) : null,
    incomePerDay: sumOrNull(income.map(usdBurn)),
    burnPerDay: sumOrNull(costs.map(usdBurn)),
    shortestRunway:
      shortest && shortest.runwayDays !== null
        ? { days: shortest.runwayDays, label: shortest.label }
        : null,
    ratesUsed: [...ratesUsed.values()],
    unconverted,
  };
}
