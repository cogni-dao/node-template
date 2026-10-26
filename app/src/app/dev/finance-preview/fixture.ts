// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `app/dev/finance-preview/fixture`
 * Purpose: Explicitly synthetic, sparse-first Financials preview scenarios.
 * Scope: Static data only; no config, secrets, adapters or provider reads.
 * Invariants: Sparse data mirrors current source coverage, not live balances.
 * Side-effects: none
 * Links: admin/payments/MoneyPlaneTable.tsx
 * @internal
 */
import type { MoneyPlaneRow } from "@cogni/money-plane";
import type { MoneyPlaneTableProps } from "@/app/(admin)/admin/payments/MoneyPlaneTable";

const takenAt = "2026-10-26T00:00:00.000Z";
const base: MoneyPlaneRow = {
  plane: "",
  label: "",
  kind: "usage",
  balance: null,
  currency: null,
  burnPerDay: null,
  runwayDays: null,
  grade: "UNKNOWN",
  observedAt: takenAt,
};
const services: MoneyPlaneRow[] = [
  {
    ...base,
    plane: "ai:operator-covered",
    label: "Node AI share",
    source: "Operator sponsorship",
    payer: "Operator",
    beneficiary: "This node",
    coverage: "operator-covered",
  },
  {
    ...base,
    plane: "hosting:operator-covered",
    label: "Node hosting share",
    source: "Operator sponsorship",
    payer: "Operator",
    beneficiary: "This node",
    coverage: "operator-covered",
  },
];
export const sparsePreview: MoneyPlaneTableProps = {
  takenAt,
  treasuryPlane: null,
  configuredWalletPlanes: [],
  costRateEvidence: [],
  rows: services,
};
export const richPreview: MoneyPlaneTableProps = {
  takenAt,
  treasuryPlane: "base:dao",
  configuredWalletPlanes: ["base:dao", "base:steward"],
  rows: [
    {
      ...base,
      plane: "base:dao",
      label: "DAO treasury / Operator wallet",
      kind: "wallet",
      balance: 1207.071234,
      currency: "USDC",
      grade: "INFO",
      source: "Base public chain",
      sourceObservedAt: takenAt,
      freshness: "current",
    },
    {
      ...base,
      plane: "base:steward",
      label: "Steward wallet",
      kind: "wallet",
      balance: 7.071234,
      currency: "USDC",
      grade: "INFO",
      source: "Base public chain",
      sourceObservedAt: takenAt,
      freshness: "current",
    },
    {
      ...base,
      plane: "demo:hosting",
      label: "Akash hosting",
      payer: "Operator",
      beneficiary: "Research node · North America",
      source: "Hosting contract",
      coverage: "operator-covered",
      nativeRate: { amount: "123.456789", currency: "uact", per: "block" },
      cumulativeVendorTransfer: { amount: "5432100.123456", currency: "uact" },
    },
    {
      ...base,
      plane: "demo:ai",
      label: "AI inference",
      payer: "Operator",
      beneficiary: "Research node",
      kind: "prepaid",
      balance: 10,
      currency: "USD",
      burnPerDay: 2,
      runwayDays: 5,
      grade: "RED",
      source: "Synthetic provider evidence",
      sourceObservedAt: takenAt,
      freshness: "current",
    },
    {
      ...base,
      plane: "demo:missing",
      label: "Storage and archiving with an unusually long service name",
      payer: "This DAO",
      source: "Synthetic unavailable source",
      reasonCode: "unreadable",
    },
  ],
  costRateEvidence: [
    {
      sourceId: "demo:hosting",
      ownerId: "operator",
      scopeId: "operator-fleet",
      instrumentId: "akash:uact",
      basis: { kind: "contract", active: true },
      rate: { amount: "123.456789", currency: "uact", per: "block" },
      sourceObservedAt: null,
      partial: true,
    },
    {
      sourceId: "demo:ai",
      ownerId: "operator",
      scopeId: "operator-fleet",
      instrumentId: "demo:provider-credit",
      basis: {
        kind: "measured",
        start: "2026-10-24T00:00:00Z",
        end: "2026-10-25T00:00:00Z",
      },
      rate: { amount: "2", currency: "USD", per: "day" },
      sourceObservedAt: takenAt,
      partial: true,
    },
  ],
};
