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

import { useEpochContext, type EpochsClient } from "../context";
import { epochJson, fetchEpochView } from "./useEpochsPage";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";

import type {
  ApiIngestionReceipt,
  EpochDto,
  UserProjectionDto,
} from "../lib/compose-epoch";
import { composeEpochView } from "../lib/compose-epoch";
import type { EpochView } from "../types";

export {
  selectFinishEpochWork,
  isEligibleForFinishEpochWork,
} from "@cogni/attribution-ledger/presentation";
import {
  selectFinishEpochWork,
  type AdminEpochDto,
  type SettlementLifecycle,
  type FinishEpochSelection,
} from "@cogni/attribution-ledger/presentation";
export type {
  AdminEpochDto,
  SettlementLifecycle,
  FinishEpochSelection,
  FinishEpochWorkKind,
  EpochSettlementLifecycle,
} from "@cogni/attribution-ledger/presentation";
export interface FinishEpochWorkspaceData {
  readonly selection: FinishEpochSelection | null;
  readonly epochView: EpochView | null;
  readonly lifecycleUnavailable: boolean;
}

async function fetchFinishEpochWorkspace(
  client: EpochsClient
): Promise<FinishEpochWorkspaceData> {
  const [epochResponse, lifecycleResponse] = await Promise.all([
    epochJson<{ epochs: AdminEpochDto[] }>(
      client,
      client.endpoints.epochs + "?limit=200"
    ),
    epochJson<
      SettlementLifecycle & { finishSelection?: FinishEpochSelection | null }
    >(client, client.endpoints.lifecycle).then(
      (value) => ({ value, unavailable: false as const }),
      () => ({ value: null, unavailable: true as const })
    ),
  ]);

  const selection = lifecycleResponse.value?.finishSelection ?? null;
  const epochView =
    selection?.kind === "open_review" || selection?.kind === "finalize"
      ? await fetchEpochView(client, selection.epoch)
      : null;

  return {
    selection,
    epochView,
    lifecycleUnavailable:
      lifecycleResponse.unavailable ||
      lifecycleResponse.value?.finishSelection === undefined ||
      lifecycleResponse.value?.publicationEvidence === "unknown",
  };
}

export function useFinishEpochWorkspace(): UseQueryResult<
  FinishEpochWorkspaceData,
  Error
> {
  const { client } = useEpochContext();
  return useQuery({
    queryKey: ["governance", "finish-epoch"],
    queryFn: () => fetchFinishEpochWorkspace(client),
    staleTime: 15_000,
  });
}
