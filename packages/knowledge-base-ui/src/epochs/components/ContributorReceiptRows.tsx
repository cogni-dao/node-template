// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { useQuery } from "@tanstack/react-query";
import { type ReactElement, useState } from "react";
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
  const [offset, setOffset] = useState(0);
  const complete =
    epoch.status !== "finalized" &&
    offset === 0 &&
    contributor.receipts.length >= contributor.receiptCount;
  const query = useQuery({
    queryKey: [
      ...queryKeyPrefix,
      "epochs",
      epoch.id,
      "contributor",
      contributor.claimantKey,
      offset,
    ],
    staleTime: 60_000,
    retry: false,
    enabled: !complete,
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
  const receipts: readonly IngestionReceipt[] = complete
    ? contributor.receipts
    : (query.data?.events ?? []).map((receipt) => ({
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
  const total = complete
    ? contributor.receiptCount
    : (query.data?.total ?? contributor.receiptCount);
  return (
    <>
      {!complete && query.isLoading ? (
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
      {!query.isLoading && !query.error && receipts.length === 0 ? (
        <TableRow>
          <TableCell colSpan={6}>No contributions</TableCell>
        </TableRow>
      ) : null}
      {(total > 50 && !complete) || offset > 0 ? (
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
