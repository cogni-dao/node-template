// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/attribution/http/lifecycle`
 * Purpose: Composes persisted settlement reads with live chain evidence for the lifecycle endpoint.
 * Scope: Auth-agnostic read orchestration and wire mapping. Does not mutate settlement or infer publication from epoch order.
 * Invariants: NODE_SCOPED, REVISION_SEQUENCE_COVERAGE, UNKNOWN_PUBLICATION_FAILS_CLOSED, ALL_MATH_BIGINT.
 * Side-effects: IO through injected store and live-root reader.
 * Links: packages/attribution-ledger/src/settlement-lifecycle.ts
 * @internal
 */

import { selectFinishEpochWork } from "../read/finish-work";
import { toEpochDto } from "../read/dto";

import {
  type AttributionStore,
  deriveSettlementLifecycle,
  type SettlementRevisionRecord,
} from "../index";
import {
  settlementLifecycleOperation,
  type SettlementLifecycleOutput,
} from "../contracts/attribution.settlement-lifecycle.v1.contract";

const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface ReadSettlementLifecycleDeps {
  readonly store: AttributionStore;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly chainId: number;
  readonly distributorAddress: string | null;
  readonly readLiveRoot: (
    chainId: number,
    distributorAddress: string
  ) => Promise<string | null>;
}

/** Read and map one node's settlement lifecycle without exposing raw liabilities. */
export async function readSettlementLifecycle(
  deps: ReadSettlementLifecycleDeps
): Promise<SettlementLifecycleOutput> {
  const [epochs, liabilities, latestRevision] = await Promise.all([
    deps.store.listEpochs(deps.nodeId),
    deps.store.listClaimantLiabilities(deps.nodeId, deps.scopeId),
    deps.store.getLatestSettlementRevision(deps.nodeId, deps.scopeId),
  ]);

  const publication = await resolvePublicationEvidence(deps);
  const lifecycle = deriveSettlementLifecycle({
    epochs,
    liabilities,
    latestRevision,
    publicationEvidence: publication.evidence,
    liveRevision: publication.liveRevision,
  });

  const view = {
    publicationEvidence: lifecycle.publicationEvidence,
    liveRevision: toRevisionSummary(lifecycle.liveRevision),
    latestRevision: toRevisionSummary(lifecycle.latestRevision),
    epochs: lifecycle.epochs.map((epoch) => ({
      epochId: epoch.epochId.toString(),
      liabilityCount: epoch.liabilityCount,
      settledLiabilityCount: epoch.settledLiabilityCount,
      publishedLiabilityCount: epoch.publishedLiabilityCount,
    })),
  };
  const epochDtos = epochs.map(toEpochDto);
  const selected = selectFinishEpochWork(epochDtos, view, Date.now());
  const selectedEpoch = selected
    ? epochDtos.find((epoch) => epoch.id === selected.epoch.id)
    : null;
  return {
    ...view,
    finishSelection:
      selected && selectedEpoch
        ? {
            ...selected,
            epoch: {
              ...selectedEpoch,
              approvers: selectedEpoch.approvers
                ? [...selectedEpoch.approvers]
                : null,
            },
          }
        : null,
  };
}

async function resolvePublicationEvidence(
  deps: ReadSettlementLifecycleDeps
): Promise<{
  readonly evidence: "matched" | "not_published" | "unknown";
  readonly liveRevision: SettlementRevisionRecord | null;
}> {
  if (!deps.distributorAddress) {
    return { evidence: "unknown", liveRevision: null };
  }

  let liveRoot: string | null;
  try {
    liveRoot = await deps.readLiveRoot(deps.chainId, deps.distributorAddress);
  } catch {
    return { evidence: "unknown", liveRevision: null };
  }
  if (liveRoot === null) {
    return { evidence: "unknown", liveRevision: null };
  }
  if (liveRoot.toLowerCase() === ZERO_ROOT) {
    return { evidence: "not_published", liveRevision: null };
  }

  const liveRevision = await deps.store.getSettlementRevisionByMerkleRoot(
    deps.nodeId,
    deps.scopeId,
    liveRoot
  );
  if (!liveRevision) {
    return { evidence: "unknown", liveRevision: null };
  }
  return { evidence: "matched", liveRevision };
}

function toRevisionSummary(revision: SettlementRevisionRecord | null) {
  if (!revision) return null;
  return {
    sequence: revision.sequence.toString(),
    merkleRoot: revision.merkleRoot,
    cumulativeTotal: revision.cumulativeTotal.toString(),
  };
}

/** Stable terminal event for the lifecycle read; hosts bind request context. */
export const SETTLEMENT_LIFECYCLE_READ_EVENT =
  "attribution.settlement_lifecycle.read" as const;

/** Validate the public wire response and return only coarse observability fields. */
export async function handleSettlementLifecycle(
  deps: ReadSettlementLifecycleDeps
) {
  const body = settlementLifecycleOperation.output.parse(
    await readSettlementLifecycle(deps)
  );
  return {
    status: 200,
    body,
    event: {
      event: SETTLEMENT_LIFECYCLE_READ_EVENT,
      outcome: "ok" as const,
      publicationEvidence: body.publicationEvidence,
      count: body.epochs.length,
    },
  };
}
