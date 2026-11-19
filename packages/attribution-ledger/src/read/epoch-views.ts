// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/attribution/read/epoch-views`
 * Purpose: The epoch read views every node serves: the epoch list and the epoch activity
 *   (window receipts ∪ epoch-selected receipts, joined to selections, with read-time identity resolution).
 * Scope: Reads over a narrow, read-only store port (`EpochReadStore`). The views never write and never
 *   take a callback. Identity resolutions found at read time come back as `pendingSelectionUpdates`; the
 *   caller decides whether to persist them (`persistSelectionUpdates`, a separate write port) and what to
 *   log. HTTP, auth and node resolution stay in the node.
 * Invariants:
 *   - PURE_READ_VIEWS: no write, no callback. A callback that reads its own call's result runs before
 *     that result is bound (TDZ, operator bug.5647).
 *   - NODE_SCOPED: receipt and epoch-list reads take the passed nodeId, and an epoch whose nodeId differs
 *     from the passed nodeId reads as not found.
 *   - BOUNDED_READS: every store read is one page (limit is capped by the caller's contract); identity
 *     resolution runs only for the page's receipts.
 *   - SELECTION_IS_THE_GATE: any epoch status; no finalized gate.
 * Side-effects: IO (database reads through the injected store only)
 * Links: src/store.ts, https://node-template.cognidao.org/knowledge/attribution-package-boundary
 * @public
 */

import type { AttributionStore } from "../store";
import { toEpochDto, toIngestionReceiptDto, toSelectionDto } from "./dto";

/** The read-only store calls the epoch views make. Any adapter with these methods satisfies it. */
export type EpochReadStore = Pick<
  AttributionStore,
  | "getEpoch"
  | "listEpochsPage"
  | "getEpochActivityPage"
  | "getSelectionForReceipts"
  | "resolveIdentities"
>;

/** The one write `persistSelectionUpdates` makes. */
export type SelectionUserIdWriter = Pick<
  AttributionStore,
  "updateSelectionUserId"
>;

/** One page request. */
export interface EpochPage {
  readonly limit: number;
  readonly offset: number;
}

/** A GitHub identity resolved at read time whose selection row still has no user. */
export interface PendingSelectionUpdate {
  readonly epochId: bigint;
  readonly receiptId: string;
  readonly userId: string;
}

/** One activity event: a receipt DTO with its selection DTO, or null when not selected. */
export type EpochActivityEvent = ReturnType<typeof toIngestionReceiptDto> & {
  selection: ReturnType<typeof toSelectionDto> | null;
};

export interface EpochActivityView {
  readonly events: EpochActivityEvent[];
  readonly epochId: string;
  readonly total: number;
}

export interface EpochActivityResult {
  readonly view: EpochActivityView;
  /** Selection rows to fill with a resolved user. Empty when nothing resolved. */
  readonly pendingSelectionUpdates: readonly PendingSelectionUpdate[];
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
}

/**
 * One page of a node's epochs as DTOs, plus the matching count. With no `status`, open epochs
 * are included; a public route passes `{ status: "finalized" }`.
 */
export async function listEpochsView(
  store: Pick<EpochReadStore, "listEpochsPage">,
  nodeId: string,
  page: EpochPage,
  filter?: Parameters<EpochReadStore["listEpochsPage"]>[2]
): Promise<{ epochs: ReturnType<typeof toEpochDto>[]; total: number }> {
  const { epochs, total } = await store.listEpochsPage(nodeId, page, filter);
  return { epochs: epochs.map(toEpochDto), total };
}

/**
 * Build one page of the activity view for `epochId`, or null when the epoch does not exist
 * for `nodeId`. `epochIdRaw` is echoed back as `epochId`, so a route keeps its path segment.
 */
export async function buildEpochActivityView(
  store: EpochReadStore,
  nodeId: string,
  epochId: bigint,
  epochIdRaw: string,
  page: EpochPage
): Promise<EpochActivityResult | null> {
  const epoch = await store.getEpoch(epochId);
  if (!epoch || epoch.nodeId !== nodeId) return null;

  const { receipts, total } = await store.getEpochActivityPage(
    nodeId,
    epochId,
    { periodStart: epoch.periodStart, periodEnd: epoch.periodEnd },
    page
  );
  const selections =
    receipts.length > 0
      ? await store.getSelectionForReceipts(
          epochId,
          receipts.map((r) => r.receiptId)
        )
      : [];
  const selectionByReceipt = new Map(selections.map((s) => [s.receiptId, s]));

  const unresolvedGithubIds = new Set<string>();
  for (const r of receipts) {
    const sel = selectionByReceipt.get(r.receiptId);
    if ((!sel || sel.userId === null) && r.source === "github") {
      unresolvedGithubIds.add(r.platformUserId);
    }
  }
  const resolved =
    unresolvedGithubIds.size > 0
      ? await store.resolveIdentities("github", [...unresolvedGithubIds])
      : new Map<string, string>();

  const pendingSelectionUpdates: PendingSelectionUpdate[] = [];
  const events: EpochActivityEvent[] = receipts.map((r) => {
    const sel = selectionByReceipt.get(r.receiptId);
    const resolvedUserId =
      r.source === "github" && (!sel || sel.userId === null)
        ? (resolved.get(r.platformUserId) ?? null)
        : null;
    if (sel && sel.userId === null && resolvedUserId) {
      pendingSelectionUpdates.push({
        epochId,
        receiptId: r.receiptId,
        userId: resolvedUserId,
      });
    }
    return {
      ...toIngestionReceiptDto(r),
      selection: sel
        ? toSelectionDto({ ...sel, userId: resolvedUserId ?? sel.userId })
        : null,
    };
  });

  return {
    view: { events, epochId: epochIdRaw, total },
    pendingSelectionUpdates,
    resolvedCount: resolved.size,
    unresolvedCount: unresolvedGithubIds.size - resolved.size,
  };
}

/**
 * Persist read-time identity resolutions. Never rejects: each update settles on its own.
 * The caller may await it or let it run in the background.
 */
export async function persistSelectionUpdates(
  store: SelectionUserIdWriter,
  updates: readonly PendingSelectionUpdate[]
): Promise<void> {
  await Promise.allSettled(
    updates.map((u) =>
      store.updateSelectionUserId(u.epochId, u.receiptId, u.userId)
    )
  );
}
