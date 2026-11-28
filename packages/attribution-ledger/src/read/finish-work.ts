// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { EpochDto as WireEpochDto } from "../contracts/attribution.list-epochs.v1.contract";
type EpochDto = Pick<
  WireEpochDto,
  | "id"
  | "status"
  | "periodStart"
  | "periodEnd"
  | "weightConfig"
  | "poolTotalCredits"
>;
export interface AdminEpochDto extends EpochDto {
  readonly approvers: readonly string[] | null;
}

export interface EpochSettlementLifecycle {
  readonly epochId: string;
  readonly liabilityCount: number;
  readonly settledLiabilityCount: number;
  readonly publishedLiabilityCount: number | null;
}

export interface SettlementLifecycle {
  readonly publicationEvidence: "matched" | "not_published" | "unknown";
  readonly liveRevision: {
    readonly sequence: string;
    readonly merkleRoot: string;
    readonly cumulativeTotal: string;
  } | null;
  readonly latestRevision: {
    readonly sequence: string;
    readonly merkleRoot: string;
    readonly cumulativeTotal: string;
  } | null;
  readonly epochs: readonly EpochSettlementLifecycle[];
}

export type FinishEpochWorkKind = "open_review" | "finalize" | "publish";

export interface FinishEpochSelection {
  readonly kind: FinishEpochWorkKind;
  readonly epoch: AdminEpochDto;
  readonly lifecycle: EpochSettlementLifecycle | null;
}

function oldestFirst(a: AdminEpochDto, b: AdminEpochDto): number {
  const periodOrder = Date.parse(a.periodEnd) - Date.parse(b.periodEnd);
  if (periodOrder !== 0) return periodOrder;
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

function latestSettlementIsPending(
  lifecycle: SettlementLifecycle | null
): boolean {
  if (!lifecycle?.latestRevision) return false;
  if (lifecycle.publicationEvidence === "unknown") return false;
  if (lifecycle.publicationEvidence === "not_published") return true;
  if (!lifecycle.liveRevision) return false;
  return (
    lifecycle.liveRevision.merkleRoot.toLowerCase() !==
    lifecycle.latestRevision.merkleRoot.toLowerCase()
  );
}

/** Pure priority policy used by the Review workspace and its unit tests. */
export function selectFinishEpochWork(
  epochs: readonly AdminEpochDto[],
  lifecycle: SettlementLifecycle | null,
  nowMs: number
): FinishEpochSelection | null {
  const ordered = [...epochs].sort(oldestFirst);
  const review = ordered.find((epoch) => epoch.status === "review");
  if (review) return { kind: "finalize", epoch: review, lifecycle: null };

  const endedOpen = ordered.find(
    (epoch) =>
      epoch.status === "open" &&
      Number.isFinite(Date.parse(epoch.periodEnd)) &&
      Date.parse(epoch.periodEnd) <= nowMs
  );
  if (endedOpen) {
    return { kind: "open_review", epoch: endedOpen, lifecycle: null };
  }

  if (!latestSettlementIsPending(lifecycle) || !lifecycle) return null;
  const lifecycleByEpoch = new Map(
    lifecycle.epochs.map((epoch) => [epoch.epochId, epoch])
  );
  const publishEpoch = [...ordered].reverse().find((epoch) => {
    if (epoch.status !== "finalized") return false;
    const progress = lifecycleByEpoch.get(epoch.id);
    if (!progress || progress.settledLiabilityCount === 0) return false;
    return (
      progress.publishedLiabilityCount === null ||
      progress.publishedLiabilityCount < progress.settledLiabilityCount
    );
  });

  return publishEpoch
    ? {
        kind: "publish",
        epoch: publishEpoch,
        lifecycle: lifecycleByEpoch.get(publishEpoch.id) ?? null,
      }
    : null;
}

/**
 * Authority is the one node-admin check (`isNodeAdmin`, decided on the server from the caller's bound wallets); the login wallet never grants it.
 * The wallet here is the SIGNER of the finalize signature: signing needs one, and finalize accepts only a signer in the epoch's pinned set.
 */
export function isEligibleForFinishEpochWork(params: {
  readonly selection: FinishEpochSelection;
  readonly walletAddress: string | null;
  readonly isNodeAdmin: boolean;
}): boolean {
  if (!params.walletAddress || !params.isNodeAdmin) return false;
  if (params.selection.kind === "open_review") return true;
  const pinned = params.selection.epoch.approvers;
  if (!pinned || pinned.length === 0) return true;
  const signer = params.walletAddress.toLowerCase();
  return pinned.some((approver) => approver.toLowerCase() === signer);
}
