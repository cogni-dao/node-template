// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useEpochsPage`
 * Purpose: React Query hooks for the epoch page: the epoch list, one settlement-lifecycle read, and one composed view per epoch the user is looking at.
 * Scope: Client-side data fetching. The page's first load is the list plus the settlement lifecycle plus the current epoch's own reads. A past epoch is read only when its row is opened, so first-load requests do not grow with the number of epochs. Does not access database directly.
 * Invariants: BOUNDED_FIRST_LOAD (request count independent of epoch count), CURRENT_NOT_BLOCKED_BY_PAST, LIFECYCLE_FAILURE_IS_UNKNOWN. Prefers open epoch as current, falls back to review.
 * Side-effects: IO (HTTP GET to ledger API endpoints)
 * Links: src/features/governance/types.ts, src/features/governance/lib/compose-epoch.ts, bug.0068
 * @public
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type {
  ApiIngestionReceipt,
  EpochClaimantsDto,
  EpochDto,
  UserProjectionDto,
} from "@/features/governance/lib/compose-epoch";
import {
  composeEpochView,
  composeEpochViewFromClaimants,
} from "@/features/governance/lib/compose-epoch";
import {
  type SettlementLifecycleEvidence,
  UNKNOWN_SETTLEMENT_LIFECYCLE,
} from "@/features/governance/lib/epoch-lifecycle-state";
import type { EpochView } from "@/features/governance/types";

export interface EpochListData {
  /** Open epoch, else the first review epoch; null when there is none. */
  readonly current: EpochDto | null;
  /** Every other non-open epoch, newest period first. Summary fields only. */
  readonly pastEpochs: readonly EpochDto[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

/** Compose an open/review epoch using user-projections (live data). */
async function composeLiveEpoch(epoch: EpochDto): Promise<EpochView> {
  const [userProjectionsRes, activityRes] = await Promise.all([
    fetchJson<{ userProjections: UserProjectionDto[] }>(
      `/api/v1/attribution/epochs/${epoch.id}/user-projections`
    ),
    fetchJson<{ events: ApiIngestionReceipt[] }>(
      `/api/v1/attribution/epochs/${epoch.id}/activity?limit=200`
    ),
  ]);
  return composeEpochView(
    epoch,
    userProjectionsRes.userProjections,
    activityRes.events
  );
}

/** Compose one epoch: finalized uses claimant-based attribution (frozen data), others use live projections. */
async function composeEpoch(epoch: EpochDto): Promise<EpochView> {
  if (epoch.status === "finalized") {
    const [claimantsRes, activityRes] = await Promise.all([
      fetchJson<EpochClaimantsDto>(
        `/api/v1/attribution/epochs/${epoch.id}/claimants`
      ),
      fetchJson<{ events: ApiIngestionReceipt[] }>(
        `/api/v1/attribution/epochs/${epoch.id}/activity?limit=200`
      ),
    ]);
    return composeEpochViewFromClaimants(
      epoch,
      claimantsRes,
      activityRes.events
    );
  }
  // Open and review epochs use user-projections
  return composeLiveEpoch(epoch);
}

/** Partition the epoch list into the current epoch and the past epochs. */
export function partitionEpochs(epochs: readonly EpochDto[]): EpochListData {
  // Find the current epoch: prefer open, fall back to most recent review
  const current =
    epochs.find((e) => e.status === "open") ??
    epochs.find((e) => e.status === "review") ??
    null;

  // Past = everything except the current epoch, sorted newest-first by periodEnd
  const pastEpochs = epochs
    .filter((e) => e !== current && e.status !== "open")
    .sort(
      (a, b) =>
        new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime()
    );
  return { current, pastEpochs };
}

/** One list read. Never fans out per epoch. */
export function useEpochsPage(): UseQueryResult<EpochListData, Error> {
  return useQuery({
    queryKey: ["governance", "epochs", "list"],
    queryFn: async () => {
      const { epochs } = await fetchJson<{ epochs: EpochDto[] }>(
        "/api/v1/attribution/epochs?limit=200"
      );
      return partitionEpochs(epochs);
    },
    staleTime: 60_000,
  });
}

/**
 * One fail-closed settlement-lifecycle read shared by every rail. It runs beside the list and
 * never gates the contributor table. A failed read is `unknown`, never complete.
 */
export function useSettlementLifecycle(): UseQueryResult<
  SettlementLifecycleEvidence,
  Error
> {
  return useQuery({
    queryKey: ["governance", "epochs", "settlement-lifecycle"],
    queryFn: () =>
      fetchJson<SettlementLifecycleEvidence>(
        "/api/v1/attribution/settlement-lifecycle"
      ).catch(() => UNKNOWN_SETTLEMENT_LIFECYCLE),
    staleTime: 60_000,
  });
}

/**
 * The composed view of one epoch: its contributors and unresolved activity.
 * `enabled: false` reads the cache only, so a collapsed row never starts a fetch.
 */
export function useEpochView(
  epoch: EpochDto,
  options: { readonly enabled?: boolean } = {}
): UseQueryResult<EpochView, Error> {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ["governance", "epochs", "view", epoch.id, epoch.status],
    queryFn: () => composeEpoch(epoch),
    enabled,
    staleTime: 60_000,
  });
}
