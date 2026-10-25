// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/types`
 * Purpose: The one row model every money-plane reader returns and every node renders, plus the reader port.
 * Scope: Types only. Does not read, grade, or render anything.
 * Invariants: ONE_ROW_MODEL — a per-row Pay button is added by setting `payAction`, never by reshaping the row. PACKAGE_LEAF_NO_ENV — fetch is injected through FetchLike.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

/** UNKNOWN = could not be measured (never GREEN). INFO = holdings with no runway semantics (wallets). */
export type Grade = "GREEN" | "YELLOW" | "RED" | "UNKNOWN" | "INFO";

/** prepaid: balance ÷ burn = runway · usage: billed after the fact · expiry: dated · wallet: holdings. */
export type PlaneKind = "prepaid" | "usage" | "fixed" | "expiry" | "wallet";

export type ReasonCode =
  | "unconfigured"
  | "unreadable"
  | "timeout"
  | "stale"
  | "burn_unmeasured"
  | "lease_starved"
  | "no_leases"
  | "escrow_advisory";

export type PayAction =
  /** The node's existing amount-only steward withdrawal (POST /api/v1/payments/steward-withdrawal). */
  | { kind: "fund-steward" }
  | {
      kind: "steward-checkout";
      vendor: "cherry" | "openrouter";
      checkoutUrl: string;
    }
  | { kind: "external"; url: string; label: string };

/** Exact source-native decimal text for reporting; no conversion or settlement arithmetic. */
export interface NativeAmount {
  amount: string;
  currency: string;
}

export interface NativeRate extends NativeAmount {
  per: "day" | "month" | "block";
}

export interface MoneyPlaneRow {
  /** Stable id, e.g. "openrouter:account", "base:steward-wallet". */
  plane: string;
  label: string;
  kind: PlaneKind;
  /** Display-only native units (USD, USDC, ACT, EUR …); null when unread. Never settlement arithmetic. */
  balance: number | null;
  currency: string | null;
  /** Native units per day; usage-billed planes report their spend rate. */
  burnPerDay: number | null;
  /** prepaid: balance ÷ burn; expiry: days left; usage and wallet: null. */
  runwayDays: number | null;
  grade: Grade;
  /** ISO read-at time; not a persisted source observation timestamp. */
  observedAt: string;
  /** Safe human source label, never a URL or credential. */
  source?: string;
  sourceObservedAt?: string | null;
  freshness?: "current" | "stale" | "unknown";
  /** Economic payer and beneficiary; wallet custody alone proves neither. */
  payer?: string;
  beneficiary?: string;
  coverage?: "direct" | "operator-covered" | "unknown";
  nativeRate?: NativeRate;
  /** Aggregate vendor-transfer evidence, not an individual payment timeline. */
  cumulativeVendorTransfer?: NativeAmount;
  reasonCode?: ReasonCode;
  /** ≤60 chars; never carries a URL, key or address. */
  detail?: string;
  /** Cumulative spend counter (e.g. OpenRouter total_usage) a scheduler can difference into burn. */
  usageTotal?: number;
  payAction?: PayAction;
}

/** The subset of `fetch` the readers use; the global `fetch` satisfies it. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export interface PlaneReader {
  readonly plane: string;
  /** Used for the fallback row when the reader throws or times out. */
  readonly label?: string;
  readonly kind?: PlaneKind;
  /** Carried onto the fallback row so an action stays reachable while its plane is unreadable. */
  readonly payAction?: PayAction;
  read(signal: AbortSignal): Promise<MoneyPlaneRow>;
}

export interface MoneyPlaneSnapshot {
  takenAt: string;
  rows: MoneyPlaneRow[];
  worst: Grade;
}
