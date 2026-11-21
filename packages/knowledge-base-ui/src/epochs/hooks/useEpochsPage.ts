// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
/** Selected-epoch reads only: overview + lifecycle + summary + activity. No historical fanout. */
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEpochContext, withEpochQuery, type EpochsClient } from "../context";
import {
  composeEpochViewFromSummary,
  type EpochDto,
  type ApiIngestionReceipt,
} from "../lib/compose-epoch";
import {
  UNKNOWN_SETTLEMENT_LIFECYCLE,
  type SettlementLifecycleEvidence,
} from "../lib/epoch-lifecycle-state";
import type { ContributorSummaryPage } from "@cogni/attribution-ledger/http";

export interface EpochListData {
  readonly current: EpochDto | null;
  readonly pastEpochs: readonly EpochDto[];
  readonly historyTotal: number;
}
export async function epochJson<T>(
  client: EpochsClient,
  url: string,
  signal?: AbortSignal
): Promise<T> {
  const response = await client.request(url, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        `HTTP ${response.status}: ${await response.text().catch(() => "")}`
      ),
      { status: response.status }
    );
  return response.json() as Promise<T>;
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
      (epoch) => epoch !== current && epoch.status !== "open"
    ).length,
  };
}
export function useEpochsPage() {
  const { client, state } = useEpochContext();
  return useQuery({
    queryKey: ["governance", "epochs", "list", state.historyOffset],
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
        signal
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
  const { client } = useEpochContext();
  return useQuery({
    queryKey: ["governance", "epochs", "settlement-lifecycle"],
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      epochJson<SettlementLifecycleEvidence>(
        client,
        client.endpoints.lifecycle,
        signal
      ).catch(() => UNKNOWN_SETTLEMENT_LIFECYCLE),
  });
}
export async function fetchEpochView(
  client: EpochsClient,
  epoch: EpochDto,
  signal?: AbortSignal,
  offset = 0
) {
  const [summary, activity] = await Promise.all([
    epochJson<ContributorSummaryPage>(
      client,
      withEpochQuery(
        epoch.status === "finalized"
          ? client.endpoints.claimants(epoch.id)
          : client.endpoints.projections(epoch.id),
        { view: "summary", limit: 200, offset }
      ),
      signal
    ),
    epochJson<{ events: ApiIngestionReceipt[] }>(
      client,
      withEpochQuery(client.endpoints.activity(epoch.id), {
        limit: 200,
        offset: 0,
      }),
      signal
    ),
  ]);
  return composeEpochViewFromSummary(epoch, summary, activity.events);
}
export function useEpochView(
  epoch: EpochDto,
  options: { readonly enabled?: boolean } = {}
) {
  const { client, state } = useEpochContext();
  const offset = state.contributorPages?.[epoch.id] ?? 0;
  return useQuery({
    queryKey: ["governance", "epochs", "view", epoch.id, epoch.status, offset],
    staleTime: 60_000,
    retry: false,
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchEpochView(client, epoch, signal, offset),
  });
}
