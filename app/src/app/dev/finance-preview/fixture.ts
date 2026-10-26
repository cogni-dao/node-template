// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `app/dev/finance-preview/fixture`
 * Purpose: Explicitly synthetic Financials preview scenarios shaped like this node's real composition.
 * Scope: Static data only; no config, secrets, adapters or provider reads.
 * Invariants: Rows carry the same planes, labels and reason codes the server composition produces.
 * Side-effects: none
 * Links: admin/payments/money-plane.server.ts, admin/payments/MoneyPlaneTable.tsx
 * @internal
 */
import type { MoneyPlaneRow, PayAction } from "@cogni/money-plane";
import type { MoneyPlaneTableProps } from "@/app/(admin)/admin/payments/MoneyPlaneTable";

export const PREVIEW_SCENARIOS = ["live-shaped", "sparse"] as const;
export type PreviewScenario = (typeof PREVIEW_SCENARIOS)[number];

const takenAt = "2026-10-26T19:42:00.000Z";
const observedAt = "2026-10-26T19:41:58.000Z";
/** The same actions the server composition attaches (ONE_ROW_MODEL). */
const FUND_STEWARD: PayAction = { kind: "fund-steward" };
const OPENROUTER_CHECKOUT: PayAction = {
  kind: "steward-checkout",
  vendor: "openrouter",
  checkoutUrl: "https://openrouter.ai/settings/credits",
};

function wallet(
  plane: string,
  label: string,
  balance: number,
  eth: string,
  payAction?: PayAction
): MoneyPlaneRow {
  return {
    plane,
    label,
    kind: "wallet",
    balance,
    currency: "USDC",
    burnPerDay: null,
    runwayDays: null,
    grade: "INFO",
    observedAt,
    source: "Base JSON-RPC",
    sourceObservedAt: observedAt,
    freshness: "current",
    detail: eth,
    ...(payAction ? { payAction } : {}),
  };
}
function unreadableWallet(
  plane: string,
  label: string,
  payAction?: PayAction
): MoneyPlaneRow {
  return {
    plane,
    label,
    kind: "wallet",
    balance: null,
    currency: null,
    burnPerDay: null,
    runwayDays: null,
    grade: "UNKNOWN",
    observedAt,
    freshness: "unknown",
    sourceObservedAt: null,
    reasonCode: "unreadable",
    detail: "eth_call HTTP 503",
    ...(payAction ? { payAction } : {}),
  };
}
function operatorCovered(
  plane: string,
  label: string,
  detail: string
): MoneyPlaneRow {
  return {
    plane,
    label,
    kind: "usage",
    balance: null,
    currency: null,
    burnPerDay: null,
    runwayDays: null,
    grade: "UNKNOWN",
    observedAt,
    source: "Operator sponsorship",
    sourceObservedAt: null,
    freshness: "unknown",
    payer: "Operator",
    beneficiary: "This node",
    coverage: "operator-covered",
    reasonCode: "unconfigured",
    detail,
  };
}
const hosting = operatorCovered(
  "hosting:operator-covered",
  "Hosting",
  "Funded by operator · cost not yet shared"
);
const ai = operatorCovered(
  "ai:operator-covered",
  "AI",
  "Funded by operator · usage not yet shared"
);

/** Every reader answered: three wallets, OpenRouter credit without a burn measurement, operator-funded lines. */
export const liveShapedPreview: MoneyPlaneTableProps = {
  takenAt,
  treasuryPlane: "base:dao-treasury",
  rows: [
    wallet("base:dao-treasury", "DAO treasury", 74.52, "0.0021 ETH"),
    wallet(
      "base:operator-wallet",
      "Operator wallet",
      10.77,
      "0.0008 ETH",
      FUND_STEWARD
    ),
    wallet("base:steward-wallet", "Steward wallet", 7.07, "0.0003 ETH"),
    {
      plane: "openrouter:account",
      label: "OpenRouter credit",
      kind: "prepaid",
      balance: 3.1,
      currency: "USD",
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      observedAt,
      source: "OpenRouter credits API",
      sourceObservedAt: observedAt,
      freshness: "current",
      reasonCode: "burn_unmeasured",
      usageTotal: 41.9,
      payAction: OPENROUTER_CHECKOUT,
    },
    hosting,
    ai,
  ],
};

/** Wallets configured but the RPC is down, and no OpenRouter key in this environment. */
export const sparsePreview: MoneyPlaneTableProps = {
  takenAt,
  treasuryPlane: "base:dao-treasury",
  rows: [
    unreadableWallet("base:dao-treasury", "DAO treasury"),
    unreadableWallet("base:operator-wallet", "Operator wallet", FUND_STEWARD),
    unreadableWallet("base:steward-wallet", "Steward wallet"),
    {
      plane: "openrouter:account",
      label: "OpenRouter credit",
      kind: "prepaid",
      balance: null,
      currency: null,
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      observedAt,
      freshness: "unknown",
      sourceObservedAt: null,
      reasonCode: "unconfigured",
      detail: "no OpenRouter key in this environment",
      payAction: OPENROUTER_CHECKOUT,
    },
    hosting,
    ai,
  ],
};

export function previewFor(scenario: string | undefined): {
  scenario: PreviewScenario;
  report: MoneyPlaneTableProps;
} {
  return scenario === "sparse"
    ? { scenario: "sparse", report: sparsePreview }
    : { scenario: "live-shaped", report: liveShapedPreview };
}
