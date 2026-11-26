// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
/** Selected-epoch reads only: overview + lifecycle + summary + activity. No historical fanout. */
import { EpochContributorSummaryPageSchema } from "@cogni/attribution-ledger/contracts";
import type { ContributorSummaryPage } from "@cogni/attribution-ledger/http";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type EpochsClient, useEpochContext, withEpochQuery } from "../context";
import {
  type ApiIngestionReceipt,
  composeEpochViewFromSummary,
  type EpochDto,
} from "../lib/compose-epoch";
import {
  type SettlementLifecycleEvidence,
  UNKNOWN_SETTLEMENT_LIFECYCLE,
} from "../lib/epoch-lifecycle-state";
import {
  ReviewRefusal,
  reviewResponseError,
  safeReviewError,
} from "../review-errors";

import { useEpochMembership } from "./useEpochMembership";

export interface EpochListData {
  readonly current: EpochDto | null;
  readonly pastEpochs: readonly EpochDto[];
  readonly historyTotal: number;
}
export async function epochJson<T>(
  client: EpochsClient,
  url: string,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const response = await client.request(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw await reviewResponseError(response, "read");
    const data = (await response.json()) as T;
    signal?.throwIfAborted();
    return data;
  } catch (error) {
    throw safeReviewError(error, "read");
  }
}
export function partitionEpochs(epochs: readonly EpochDto[]): EpochListData {
  const current =
    epochs.find((epoch) => epoch.status === "open") ??
    [...epochs].reverse().find((epoch) => epoch.status === "review") ??
    null;
  return {
    current,
    pastEpochs: epochs
      .filter((epoch) => epoch !== current && epoch.status !== "open")
      .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd)),
    historyTotal: epochs.filter(
      (epoch) => epoch !== current && epoch.status !== "open",
    ).length,
  };
}
export function useEpochsPage() {
  const { client, state, queryKeyPrefix } = useEpochContext();
  return useQuery({
    queryKey: [...queryKeyPrefix, "epochs", "list", state.historyOffset],
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }): Promise<EpochListData> => {
      const result = await epochJson<{
        current: EpochDto | null;
        epochs: EpochDto[];
        total: number;
      }>(
        client,
        withEpochQuery(client.endpoints.epochs, {
          view: "overview",
          limit: 200,
          offset: state.historyOffset,
        }),
        signal,
      );
      return {
        current: result.current,
        pastEpochs: result.epochs,
        historyTotal: result.total,
      };
    },
  });
}
export function useSettlementLifecycle() {
  const { client, queryKeyPrefix } = useEpochContext();
  return useQuery({
    queryKey: [...queryKeyPrefix, "epochs", "settlement-lifecycle"],
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      epochJson<SettlementLifecycleEvidence>(
        client,
        client.endpoints.lifecycle,
        signal,
      ).catch(() => UNKNOWN_SETTLEMENT_LIFECYCLE),
  });
}
export async function fetchEpochView(
  client: EpochsClient,
  epoch: EpochDto,
  signal?: AbortSignal,
  offset = 0,
) {
  // Activity resolves identities; read the summary afterwards so its claimant keys
  // agree with the selections persisted by the activity request.
  const activity = await epochJson<{ epochId: string; events: ApiIngestionReceipt[] }>(
    client,
    withEpochQuery(client.endpoints.activity(epoch.id), { limit: 200, offset: 0 }),
    signal,
  );
  const summary = await epochJson<ContributorSummaryPage>(
      client,
      withEpochQuery(
        epoch.status === "finalized"
          ? client.endpoints.claimants(epoch.id)
          : client.endpoints.projections(epoch.id),
        { view: "summary", limit: 200, offset },
      ),
      signal,
    );
  const parsed = EpochContributorSummaryPageSchema.safeParse(summary);
  if (
    !parsed.success ||
    parsed.data.epochId !== epoch.id ||
    parsed.data.offset !== offset ||
    activity.epochId !== epoch.id ||
    !/^\d+$/.test(parsed.data.totalUnits) ||
    !/^\d+$/.test(parsed.data.totalPoints) ||
    parsed.data.items.some((item) => !/^\d+$/.test(item.units))
  )
    throw new ReviewRefusal("unexpected", "read");
  return composeEpochViewFromSummary(epoch, parsed.data, activity.events);
}
export function useEpochView(
  epoch: EpochDto,
  options: { readonly enabled?: boolean } = {},
) {
  const { client, state, queryKeyPrefix } = useEpochContext();
  const offset = state.contributorPages?.[epoch.id] ?? 0;
  const membership = useEpochMembership();
  const query = useQuery({
    queryKey: [
      ...queryKeyPrefix,
      "epochs",
      "view",
      epoch.id,
      epoch.status,
      offset,
    ],
    staleTime: 60_000,
    retry: false,
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchOnMount: "always",
    queryFn: ({ signal }) =>
      membership.read(epoch.id, signal, async (readId) => ({
        ...(await fetchEpochView(client, epoch, signal, offset)),
        membershipReadId: readId,
      })),
  });
  return {
    ...query,
    membershipReady:
      query.isSuccess &&
      query.fetchStatus === "idle" &&
      !query.isPlaceholderData &&
      membership.isCurrent(query.data.membershipReadId),
  };
}
