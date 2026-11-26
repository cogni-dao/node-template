// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base-ui/epochs/hooks/useFinishEpochWorkspace`
 * Purpose: Select and load the single oldest governance action that an epoch admin should finish next.
 * Scope: Client-side reads and pure selection only. Reuses existing review, finalize, and publish writers.
 * Invariants: REVIEW_BEFORE_OPEN_BEFORE_PUBLISH, OLDEST_FIRST, UNKNOWN_PUBLICATION_FAILS_CLOSED.
 * Side-effects: IO (authenticated epoch and settlement lifecycle reads)
 * Links: packages/node-contracts/src/attribution.settlement-lifecycle.v1.contract.ts, task.5038
 * @public
 */

import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type EpochsClient, useEpochContext } from "../context";
import type { EpochView } from "../types";
import { epochJson, fetchEpochView } from "./useEpochsPage";

import { useEpochMembership } from "./useEpochMembership";

export { isEligibleForFinishEpochWork } from "@cogni/attribution-ledger/presentation";

import type {
  AdminEpochDto,
  FinishEpochSelection,
  SettlementLifecycle,
} from "@cogni/attribution-ledger/presentation";

export type {
  AdminEpochDto,
  EpochSettlementLifecycle,
  FinishEpochSelection,
  FinishEpochWorkKind,
  SettlementLifecycle,
} from "@cogni/attribution-ledger/presentation";
export interface FinishEpochWorkspaceData {
  readonly selection: FinishEpochSelection | null;
  readonly epochView: EpochView | null;
  readonly lifecycleUnavailable: boolean;
  readonly readId: string;
}

async function fetchFinishEpochWorkspace(
  client: EpochsClient,
  contributorPages: Readonly<Record<string, number>>,
  signal?: AbortSignal,
): Promise<FinishEpochWorkspaceData> {
  const [, lifecycleResponse] = await Promise.all([
    epochJson<{ epochs: AdminEpochDto[] }>(
      client,
      `${client.endpoints.epochs}?limit=200`,
      signal,
    ),
    epochJson<
      SettlementLifecycle & { finishSelection?: FinishEpochSelection | null }
    >(client, client.endpoints.lifecycle, signal).then(
      (value) => ({ value, unavailable: false as const }),
      () => ({ value: null, unavailable: true as const }),
    ),
  ]);

  const selection = lifecycleResponse.value?.finishSelection ?? null;
  const epochView =
    selection?.kind === "open_review" || selection?.kind === "finalize"
      ? await fetchEpochView(
          client,
          selection.epoch,
          signal,
          contributorPages[selection.epoch.id] ?? 0,
        )
      : null;

  signal?.throwIfAborted();
  return {
    selection,
    epochView,
    readId: crypto.randomUUID(),
    lifecycleUnavailable:
      lifecycleResponse.unavailable ||
      lifecycleResponse.value?.finishSelection === undefined ||
      lifecycleResponse.value?.publicationEvidence === "unknown",
  };
}

export const finishWorkspaceKey = (
  prefix: readonly string[],
  pages: Readonly<Record<string, number>>,
) => [...prefix, "finish-epoch", pages] as const;

export function useFinishEpochWorkspace(): UseQueryResult<
  FinishEpochWorkspaceData,
  Error
> & { readonly membershipReady: boolean } {
  const { client, state, queryKeyPrefix } = useEpochContext();
  const contributorPages = state.contributorPages ?? {};
  const queryClient = useQueryClient();
  const membership = useEpochMembership();
  const queryKey = finishWorkspaceKey(queryKeyPrefix, contributorPages);
  const query = useQuery({
    behavior: membership.behavior,
    queryKey,
    queryFn: ({ signal }) =>
      membership.read(
        queryClient.getQueryData<FinishEpochWorkspaceData>(queryKey)?.epochView
          ?.id,
        signal,
        async (readId) => {
          const data = await fetchFinishEpochWorkspace(
            client,
            contributorPages,
            signal
          );
          return {
            ...data,
            epochView: data.epochView
              ? { ...data.epochView, membershipReadId: readId }
              : null,
          };
        }
      ),
    staleTime: 15_000,
    retry: false,
    refetchOnMount: "always",
  });
  return {
    ...query,
    membershipReady:
      query.isSuccess &&
      query.fetchStatus === "idle" &&
      !query.data.lifecycleUnavailable &&
      membership.isCurrent(query.data.epochView?.membershipReadId),
  };
}
