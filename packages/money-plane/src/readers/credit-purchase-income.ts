// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/readers/credit-purchase-income`
 * Purpose: Income from credit purchases: successful payment_attempts in the trailing window ÷ window days → USD per day.
 * Scope: Node-generic. The query is injected (the node owns its database); this reader only sums and labels.
 * Invariants: READERS_NEVER_THROW — a failing query is UNKNOWN `unreadable`. Zero purchases is a measured $0/day, not UNKNOWN.
 *   The window is measured on the credited time; a node that can only supply intent time says so (`basis: "intent"`).
 *   kind `income`, rail `split-inflow` supported (the 95/5 Split lands purchases automatically). `burnPerDay` holds inflow per day.
 * Side-effects: IO through the injected query only
 * Links: https://cognidao.org/knowledge/node-service-usdc-northstar
 * @public
 */

import { unknownRow } from "../row";
import type { MoneyPlaneRow, PlaneReader } from "../types";

export const CREDIT_PURCHASE_INCOME_PLANE = "income:credit-purchases";

export interface CreditPurchase {
  amountUsdCents: number;
  createdAt: Date;
}

export interface CreditPurchaseIncomeReaderOptions {
  /** Successful purchases whose `createdAt` is the credited time (or the intent time when `basis` is "intent"), at or after `since`. */
  query: (since: Date) => Promise<readonly CreditPurchase[]>;
  windowDays?: number;
  label?: string;
  now?: () => Date;
  /** Which timestamp the query returns; the dialog names it. Default "credited". */
  basis?: "credited" | "intent";
}

export function creditPurchaseIncomeReader(
  options: CreditPurchaseIncomeReaderOptions
): PlaneReader {
  const plane = CREDIT_PURCHASE_INCOME_PLANE;
  const label = options.label ?? "Credit purchases";
  const windowDays = options.windowDays ?? 30;
  const now = options.now ?? (() => new Date());
  const rail = { kind: "split-inflow" as const, status: "supported" as const };
  const basis = options.basis ?? "credited";
  return {
    plane,
    label,
    kind: "income",
    async read(): Promise<MoneyPlaneRow> {
      const at = now();
      const since = new Date(at.getTime() - windowDays * 86_400_000);
      try {
        const purchases = (await options.query(since)).filter(
          (p) =>
            Number.isFinite(p.amountUsdCents) &&
            p.amountUsdCents > 0 &&
            p.createdAt.getTime() >= since.getTime() &&
            p.createdAt.getTime() <= at.getTime()
        );
        const totalUsd =
          purchases.reduce((sum, p) => sum + p.amountUsdCents, 0) / 100;
        const observedAt = at.toISOString();
        return {
          plane,
          label,
          kind: "income",
          balance: null,
          currency: "USD",
          burnPerDay: totalUsd / windowDays,
          runwayDays: null,
          grade: "INFO",
          observedAt,
          source:
            basis === "credited"
              ? `payment_events · CREDITED · trailing ${windowDays} days`
              : `payment_attempts · CREDITED · by intent time · trailing ${windowDays} days`,
          sourceObservedAt: observedAt,
          freshness: "current",
          detail: `${purchases.length} purchases · ${totalUsd.toFixed(2)} USD in ${windowDays}d`,
          rail,
        };
      } catch {
        return {
          ...unknownRow({
            plane,
            label,
            kind: "income",
            reasonCode: "unreadable",
            observedAt: at.toISOString(),
            detail: "income read failed",
          }),
          rail,
        };
      }
    },
  };
}
