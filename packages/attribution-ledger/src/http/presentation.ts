// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  EPOCH_PAGE_MAX_LIMIT,
  toEpochDto,
  toIngestionReceiptDto,
  toSelectionDto,
} from "../read/index";
import type {
  AttributionRuntimeStore,
  ContributorSummaryPage,
} from "../read/presentation";
import type { ReadPage } from "../store";
import { readFinalizedEpochClaimants } from "./claimants";

const capPage = (page: ReadPage): ReadPage => ({
  limit: Math.min(EPOCH_PAGE_MAX_LIMIT, Math.max(1, Math.floor(page.limit))),
  offset: Math.max(0, Math.floor(page.offset)),
});

export async function readEpochOverview(
  store: AttributionRuntimeStore,
  nodeId: string,
  page: ReadPage
) {
  const current = await store.getCurrentEpoch(nodeId);
  const history = await store.listEpochHistoryPage(
    nodeId,
    current?.id ?? null,
    capPage(page)
  );
  return {
    current: current ? toEpochDto(current) : null,
    epochs: history.epochs.map(toEpochDto),
    total: history.total,
  };
}

export async function readEpochContributorSummary(
  store: AttributionRuntimeStore,
  nodeId: string,
  epochId: bigint,
  page: ReadPage
): Promise<ContributorSummaryPage | null> {
  const epoch = await store.getEpoch(epochId);
  if (!epoch || epoch.nodeId !== nodeId) return null;
  const bounded = capPage(page);
  if (epoch.status !== "finalized")
    return store.getLiveContributorSummaryPage(nodeId, epochId, bounded);
  // This is the original historical fallback, exempt for the rollout by bug.0072. No signed value changes.
  const claimants = await readFinalizedEpochClaimants(store, epochId);
  const totalUnits = claimants.items.reduce(
    (total, item) => total + BigInt(item.totalUnits),
    0n
  );
  const sorted = [...claimants.items].sort((a, b) =>
    BigInt(a.totalUnits) === BigInt(b.totalUnits)
      ? a.claimantKey.localeCompare(b.claimantKey)
      : BigInt(a.totalUnits) > BigInt(b.totalUnits)
        ? -1
        : 1
  );
  const unresolved = sorted.filter(
    (item) => item.claimant.kind === "identity" && !item.isLinked
  );
  return {
    unresolvedCount: new Set(unresolved.flatMap((item) => item.receiptIds))
      .size,
    unresolvedActivityTotal: unresolved.length,
    unresolvedActivities: unresolved
      .slice(0, EPOCH_PAGE_MAX_LIMIT)
      .map((item) => ({
        claimantKey: item.claimantKey,
        source: item.claimant.kind === "identity" ? item.claimant.provider : "",
        platformLogin: item.displayName,
        eventCount: item.receiptIds.length,
      })),
    epochId: epochId.toString(),
    total: sorted.length,
    totalUnits: totalUnits.toString(),
    totalPoints: sorted
      .reduce((sum, item) => sum + (BigInt(item.totalUnits) + 500n) / 1000n, 0n)
      .toString(),
    totalReceiptCount: sorted.reduce(
      (total, item) => total + item.receiptIds.length,
      0
    ),
    ...bounded,
    items: sorted
      .slice(bounded.offset, bounded.offset + bounded.limit)
      .map((item) => ({
        claimantKey: item.claimantKey,
        claimantKind: item.claimant.kind,
        isLinked: item.isLinked,
        displayName: item.displayName,
        claimantLabel:
          item.claimant.kind === "user"
            ? "Linked account"
            : `${item.claimant.provider} account`,
        units: item.totalUnits,
        receiptCount: item.receiptIds.length,
        creditShare: Math.round(Number(item.share) * 1000) / 10,
      })),
  };
}

export async function readEpochContributorReceipts(
  store: AttributionRuntimeStore,
  nodeId: string,
  epochId: bigint,
  claimantKey: string,
  page: ReadPage
) {
  const epoch = await store.getEpoch(epochId);
  if (!epoch || epoch.nodeId !== nodeId) return null;
  let receiptIds: readonly string[] | undefined;
  const reviewOverrides = new Map<
    string,
    { originalUnits: string; overrideUnits: string; reason: string | null }
  >();
  if (epoch.status === "finalized") {
    const frozen = await readFinalizedEpochClaimants(store, epochId);
    const claimant = frozen.items.find(
      (item) => item.claimantKey === claimantKey
    );
    if (!claimant) return null;
    receiptIds = claimant.receiptIds;
    for (const override of frozen.reviewOverrides ?? []) {
      if (override.override_units !== null)
        reviewOverrides.set(override.subject_ref, {
          originalUnits: override.original_units,
          overrideUnits: override.override_units,
          reason: override.reason,
        });
    }
  }
  const result = await store.getContributorReceiptsPage(
    nodeId,
    epochId,
    claimantKey,
    capPage(page),
    receiptIds
  );
  const selection = new Map(
    (
      await store.getSelectionForReceipts(
        epochId,
        result.receipts.map((receipt) => receipt.receiptId)
      )
    ).map((item) => [item.receiptId, item])
  );
  return {
    epochId: epochId.toString(),
    total: result.total,
    events: result.receipts.map((receipt) => ({
      ...toIngestionReceiptDto(receipt),
      selection: selection.has(receipt.receiptId)
        ? toSelectionDto(selection.get(receipt.receiptId)!)
        : null,
      reviewOverride: reviewOverrides.get(receipt.receiptId) ?? null,
    })),
  };
}
export type {
  AttributionRuntimeStore,
  ContributorSummary,
  ContributorSummaryPage,
  EpochPresentationStore,
} from "../read/presentation";

/** Stable terminal events travel with the operation. Hosts add request identity and duration. */
export const EPOCH_PRESENTATION_EVENTS = {
  overview: "attribution.epoch_overview.read",
  summary: "attribution.contributor_summary.read",
  receipts: "attribution.contributor_receipts.read",
} as const;

import { PaginationQuerySchema } from "../contracts/attribution.list-epochs.v1.contract";
import {
  ContributorActivityOutputSchema,
  EpochContributorSummaryPageSchema,
  EpochOverviewSchema,
} from "../contracts/presentation";
/** Parse client pagination without classifying output or store errors. */
export function parseEpochPage(
  params: URLSearchParams,
  event: (typeof EPOCH_PRESENTATION_EVENTS)[keyof typeof EPOCH_PRESENTATION_EVENTS],
  ids: { nodeId: string; epochId?: string }
) {
  const parsed = PaginationQuerySchema.safeParse({
    limit: params.get("limit") ?? undefined,
    offset: params.get("offset") ?? undefined,
  });
  if (parsed.success) return { ok: true as const, page: parsed.data };
  return {
    ok: false as const,
    result: {
      status: 400,
      body: { error: "Invalid pagination", code: "INVALID_PAGINATION" },
      event: {
        event,
        ...ids,
        outcome: "refused",
        errorCode: "INVALID_PAGINATION",
        count: 0,
      },
    },
  };
}
function terminal<T>(
  event: string,
  body: T | null,
  ids: { nodeId: string; epochId?: string },
  count: number
) {
  return body === null
    ? {
        status: 404,
        body: { error: "Epoch not found" },
        event: {
          event,
          ...ids,
          outcome: "refused",
          errorCode: "EPOCH_NOT_FOUND",
          count: 0,
        },
      }
    : { status: 200, body, event: { event, ...ids, outcome: "ok", count } };
}
export async function handleEpochOverview(
  store: AttributionRuntimeStore,
  nodeId: string,
  page: ReadPage
) {
  const body = EpochOverviewSchema.parse(
    await readEpochOverview(store, nodeId, page)
  );
  return terminal(
    EPOCH_PRESENTATION_EVENTS.overview,
    body,
    { nodeId },
    body.epochs.length
  );
}
export async function handleEpochContributorSummary(
  store: AttributionRuntimeStore,
  nodeId: string,
  epochId: bigint,
  page: ReadPage
) {
  const view = await readEpochContributorSummary(store, nodeId, epochId, page);
  const body =
    view === null ? null : EpochContributorSummaryPageSchema.parse(view);
  return terminal(
    EPOCH_PRESENTATION_EVENTS.summary,
    body,
    { nodeId, epochId: epochId.toString() },
    body?.items.length ?? 0
  );
}
export async function handleEpochContributorReceipts(
  store: AttributionRuntimeStore,
  nodeId: string,
  epochId: bigint,
  claimantKey: string,
  page: ReadPage
) {
  const view = await readEpochContributorReceipts(
    store,
    nodeId,
    epochId,
    claimantKey,
    page
  );
  const body =
    view === null ? null : ContributorActivityOutputSchema.parse(view);
  return terminal(
    EPOCH_PRESENTATION_EVENTS.receipts,
    body,
    { nodeId, epochId: epochId.toString() },
    body?.events.length ?? 0
  );
}
