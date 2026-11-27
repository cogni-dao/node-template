// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Complete-result presentation facts. These reads never authorize a payout or change signed data. */
import type {
  AttributionEpoch,
  AttributionStore,
  IngestionReceipt,
  ReadPage,
} from "../store";

export interface ContributorSummary {
  readonly claimantKey: string;
  readonly claimantKind: "user" | "identity";
  readonly isLinked: boolean;
  readonly displayName: string | null;
  readonly claimantLabel: string;
  readonly units: string;
  readonly receiptCount: number;
  readonly creditShare: number;
}
export interface UnresolvedActivitySummary {
  readonly claimantKey: string;
  readonly source: string;
  readonly platformLogin: string | null;
  readonly eventCount: number;
}
export interface ContributorSummaryPage {
  readonly epochId: string;
  readonly items: readonly ContributorSummary[];
  readonly total: number;
  readonly totalUnits: string;
  readonly totalPoints: string;
  readonly totalReceiptCount: number;
  /** Full included unresolved receipt count, independent of either page. */
  readonly unresolvedCount: number;
  /** First capped identity breakdown, independent of contributor offset. */
  readonly unresolvedActivities: readonly UnresolvedActivitySummary[];
  readonly unresolvedActivityTotal: number;
  readonly limit: number;
  readonly offset: number;
}
export interface EpochPresentationStore {
  getCurrentEpoch(nodeId: string): Promise<AttributionEpoch | null>;
  listEpochHistoryPage(
    nodeId: string,
    currentId: bigint | null,
    page: ReadPage
  ): Promise<{ epochs: AttributionEpoch[]; total: number }>;
  getLiveContributorSummaryPage(
    nodeId: string,
    epochId: bigint,
    page: ReadPage
  ): Promise<ContributorSummaryPage>;
  getContributorReceiptsPage(
    nodeId: string,
    epochId: bigint,
    claimantKey: string,
    page: ReadPage,
    frozenReceiptIds?: readonly string[]
  ): Promise<{ receipts: IngestionReceipt[]; total: number }>;
}
export type AttributionRuntimeStore = AttributionStore & EpochPresentationStore;

/** Integer rounding is display-only. Signed pool shares keep their existing six-decimal strings. */
export function displayShare(units: bigint, total: bigint): number {
  return total > 0n ? Number((units * 1000n + total / 2n) / total) / 10 : 0;
}
