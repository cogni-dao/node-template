// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useEffect, useRef, useState } from "react";
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
  renderRows,
}: {
  readonly epoch: EpochView;
  readonly contributor: EpochContributor;
  readonly renderRows?: (
    contributor: EpochContributor,
  ) => ReactElement[] | null;
}) {
  const { client, queryKeyPrefix } = useEpochContext();
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const reconciled = useRef(false);
  const query = useQuery({
    queryKey: [
      ...queryKeyPrefix,
      "epochs",
      epoch.id,
      epoch.status,
      "contributor",
      contributor.claimantKey,
      offset,
    ],
    staleTime: 0,
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
      reconciled.current ||
      query.isFetching ||
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
    contributor.isLinked,
    contributor.receiptCount,
    epoch.id,
    query.data,
    query.error,
    query.isFetching,
    queryClient,
    queryKeyPrefix,
  ]);
  const receipts: readonly IngestionReceipt[] = (
    query.isFetching || query.error ? [] : (query.data?.events ?? [])
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
        epoch.weightConfig?.[`${receipt.source}:${receipt.eventType}`] ?? 0,
      ),
    override: receipt.reviewOverride ?? null,
  }));
  const total = query.data?.total ?? contributor.receiptCount;
  return (
    <>
      {query.isFetching ? (
        <TableRow>
          <TableCell colSpan={6} role="status">
            Loading contributions…
          </TableCell>
        </TableRow>
      ) : null}
      {query.error ? (
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
        ? renderRows({ ...contributor, receipts })
        : receipts.map((receipt) => (
            <ContributionRow key={receipt.receiptId} receipt={receipt} />
          ))}
      {!query.isFetching && !query.error && receipts.length === 0 ? (
        <TableRow>
          <TableCell colSpan={6}>No contributions</TableCell>
        </TableRow>
      ) : null}
      {total > 50 || offset > 0 ? (
        <TableRow>
          <TableCell colSpan={6}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                disabled={offset === 0 || query.isFetching}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous contributions
              </Button>
              <span>
                {offset + 1}–{Math.min(offset + receipts.length, total)} of{" "}
                {total}
              </span>
              <Button
                disabled={offset + 50 >= total || query.isFetching}
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
