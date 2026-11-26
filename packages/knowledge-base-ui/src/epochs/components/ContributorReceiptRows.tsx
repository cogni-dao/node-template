// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { useEpochContext, withEpochQuery } from "../context";
import { epochJson } from "../hooks/useEpochsPage";
import type { ApiIngestionReceipt } from "../lib/compose-epoch";
import type { EpochContributor, EpochView, IngestionReceipt } from "../types";
import { Button, TableCell, TableRow } from "../ui";
import { ContributionRow } from "./ContributionRow";

type ReceiptEvent = ApiIngestionReceipt & {
  readonly reviewOverride?: IngestionReceipt["override"];
};
export function ContributorReceiptRows({
  epoch,
  contributor,
  membershipReady,
  renderRows,
  onMembership,
}: {
  readonly epoch: EpochView;
  readonly contributor: EpochContributor;
  readonly membershipReady: boolean;
  readonly onMembership?: (
    contributor: EpochContributor,
    offset: number
  ) => void;
  readonly renderRows?: (
    contributor: EpochContributor,
    membershipPending?: boolean,
    receiptOffset?: number
  ) => ReactElement[] | null;
}) {
  const { client, queryKeyPrefix } = useEpochContext();
  const queryClient = useQueryClient();
  const [page, setPage] = useState({
    readId: epoch.membershipReadId,
    offset: 0,
  });
  const offset = page.readId === epoch.membershipReadId ? page.offset : 0;
  const setOffset = (offset: number) =>
    setPage({ readId: epoch.membershipReadId, offset });
  const reconciled = useRef(false);
  const query = useQuery({
    queryKey: [
      ...queryKeyPrefix,
      "epochs",
      epoch.id,
      epoch.status,
      "contributor",
      contributor.claimantKey,
      epoch.membershipReadId,
      offset,
    ],
    enabled: membershipReady,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryFn: ({ signal }) =>
      epochJson<{ total: number; events: ReceiptEvent[] }>(
        client,
        withEpochQuery(client.endpoints.activity(epoch.id), {
          claimantKey: contributor.claimantKey,
          limit: 50,
          offset,
        }),
        signal,
      ),
  });
  // An identity may have been linked since the summary was read. Refresh the
  // active summary once; repeated empty results must not trigger a read loop.
  useEffect(() => {
    if (
      !membershipReady ||
      reconciled.current ||
      query.fetchStatus !== "idle" ||
      query.error ||
      !query.data ||
      contributor.isLinked ||
      contributor.receiptCount === 0 ||
      query.data.total !== 0
    )
      return;
    reconciled.current = true;
    void queryClient.invalidateQueries({
      predicate: (entry) => {
        const key = entry.queryKey;
        const start = queryKeyPrefix.length;
        if (!queryKeyPrefix.every((part, index) => key[index] === part))
          return false;
        return (
          (key[start] === "epochs" &&
            key[start + 1] === "view" &&
            key[start + 2] === epoch.id) ||
          key[start] === "finish-epoch"
        );
      },
      type: "active",
    });
  }, [
    membershipReady,
    contributor.isLinked,
    contributor.receiptCount,
    epoch.id,
    query.data,
    query.error,
    query.fetchStatus,
    queryClient,
    queryKeyPrefix,
  ]);
  const receipts: readonly IngestionReceipt[] = useMemo(
    () =>
      (!membershipReady || query.fetchStatus !== "idle" || !query.isSuccess
        ? []
        : (query.data?.events ?? [])
      ).map((receipt) => ({
        receiptId: receipt.receiptId,
        source: receipt.source,
        eventType: receipt.eventType,
        platformLogin: receipt.platformLogin,
        artifactUrl: receipt.artifactUrl,
        eventTime: receipt.eventTime,
        metadata: receipt.metadata,
        units:
          receipt.selection?.weightOverrideMilli ??
          String(
            epoch.weightConfig?.[`${receipt.source}:${receipt.eventType}`] ?? 0
          ),
        override: receipt.reviewOverride ?? null,
      })),
    [
      membershipReady,
      query.fetchStatus,
      query.isSuccess,
      query.data,
      epoch.weightConfig,
    ]
  );
  // Only verified bounded membership may move an existing local draft's owner.
  useEffect(() => {
    if (membershipReady && query.isSuccess && query.fetchStatus === "idle")
      onMembership?.({ ...contributor, receipts }, offset);
  }, [
    membershipReady,
    query.isSuccess,
    query.fetchStatus,
    query.data,
    onMembership,
    contributor,
    receipts,
    offset,
  ]);
  const total = query.data?.total ?? contributor.receiptCount;
  return (
    <>
      {!membershipReady || query.fetchStatus !== "idle" ? (
        <TableRow>
          <TableCell colSpan={6} role="status">
            Loading contributions…
          </TableCell>
        </TableRow>
      ) : null}
      {membershipReady && query.error ? (
        <TableRow>
          <TableCell colSpan={6}>
            <p role="alert">
              Couldn’t load contributions: {query.error.message}
            </p>
            <Button onClick={() => void query.refetch()}>
              Retry contributions
            </Button>
          </TableCell>
        </TableRow>
      ) : null}
      {renderRows
        ? renderRows(
            { ...contributor, receipts },
            !membershipReady || query.fetchStatus !== "idle" || query.isPending,
            offset
          )
        : receipts.map((receipt) => (
            <ContributionRow key={receipt.receiptId} receipt={receipt} />
          ))}
      {membershipReady &&
      query.fetchStatus === "idle" &&
      !query.error &&
      receipts.length === 0 ? (
        <TableRow>
          <TableCell colSpan={6}>No contributions</TableCell>
        </TableRow>
      ) : null}
      {membershipReady && (total > 50 || offset > 0) ? (
        <TableRow>
          <TableCell colSpan={6}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                disabled={offset === 0 || query.fetchStatus !== "idle"}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous contributions
              </Button>
              <span>
                {offset + 1}–{Math.min(offset + receipts.length, total)} of{" "}
                {total}
              </span>
              <Button
                disabled={offset + 50 >= total || query.fetchStatus !== "idle"}
                onClick={() => setOffset(offset + 50)}
              >
                More contributions
              </Button>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
