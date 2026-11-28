// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `finish-epoch-workspace.test`
 * Purpose: Prove deterministic admin-work selection and current/pinned approver eligibility.
 * Scope: Pure Review workspace policy only; no HTTP, wallet, or transaction behavior.
 * Invariants: REVIEW_BEFORE_OPEN_BEFORE_PUBLISH, OLDEST_FIRST, UNKNOWN_PUBLICATION_FAILS_CLOSED.
 * Side-effects: none
 * Links: src/features/governance/hooks/useFinishEpochWorkspace.ts, task.5038
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  type AdminEpochDto,
  isEligibleForFinishEpochWork,
  selectFinishEpochWork,
  type SettlementLifecycle,
} from "@cogni/attribution-ledger/presentation";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const CURRENT = "0x1111111111111111111111111111111111111111";
const PINNED = "0x2222222222222222222222222222222222222222";

function epoch(
  id: string,
  status: AdminEpochDto["status"],
  periodEnd: string,
  approvers: readonly string[] | null = null
): AdminEpochDto {
  return {
    id,
    status,
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd,
    weightConfig: {},
    poolTotalCredits: status === "finalized" ? "1000" : null,
    approvers,
  };
}

function lifecycle(
  publicationEvidence: SettlementLifecycle["publicationEvidence"]
): SettlementLifecycle {
  return {
    publicationEvidence,
    liveRevision:
      publicationEvidence === "matched"
        ? { sequence: "1", merkleRoot: "0xold", cumulativeTotal: "100" }
        : null,
    latestRevision: {
      sequence: "2",
      merkleRoot: "0xlatest",
      cumulativeTotal: "200",
    },
    epochs: [
      {
        epochId: "1",
        liabilityCount: 1,
        settledLiabilityCount: 1,
        publishedLiabilityCount: 0,
      },
      {
        epochId: "2",
        liabilityCount: 1,
        settledLiabilityCount: 1,
        publishedLiabilityCount: 0,
      },
    ],
  };
}

describe("selectFinishEpochWork", () => {
  it("selects the oldest review before ended-open and publication work", () => {
    const selected = selectFinishEpochWork(
      [
        epoch("4", "review", "2026-08-29T00:00:00.000Z", [PINNED]),
        epoch("3", "review", "2026-08-22T00:00:00.000Z", [PINNED]),
        epoch("5", "open", "2026-08-30T00:00:00.000Z"),
      ],
      lifecycle("not_published"),
      NOW
    );

    expect(selected).toMatchObject({ kind: "finalize", epoch: { id: "3" } });
  });

  it("selects the oldest ended-open epoch when no review is active", () => {
    const selected = selectFinishEpochWork(
      [
        epoch("4", "open", "2026-08-29T00:00:00.000Z"),
        epoch("3", "open", "2026-08-22T00:00:00.000Z"),
        epoch("5", "open", "2026-09-08T00:00:00.000Z"),
      ],
      null,
      NOW
    );

    expect(selected).toMatchObject({
      kind: "open_review",
      epoch: { id: "3" },
    });
  });

  it("uses the newest finalized context with proven unpublished liability for the latest global settlement", () => {
    const selected = selectFinishEpochWork(
      [
        epoch("1", "finalized", "2026-08-08T00:00:00.000Z", [PINNED]),
        epoch("2", "finalized", "2026-08-15T00:00:00.000Z", [PINNED]),
      ],
      lifecycle("matched"),
      NOW
    );

    expect(selected).toMatchObject({ kind: "publish", epoch: { id: "2" } });
  });

  it("never exposes Publish when chain evidence is unknown", () => {
    expect(
      selectFinishEpochWork(
        [epoch("2", "finalized", "2026-08-15T00:00:00.000Z", [PINNED])],
        lifecycle("unknown"),
        NOW
      )
    ).toBeNull();
  });
});

describe("isEligibleForFinishEpochWork", () => {
  it("requires the node-admin decision to open review, whatever wallet the session logged in with", () => {
    const selection = selectFinishEpochWork(
      [epoch("3", "open", "2026-08-22T00:00:00.000Z")],
      null,
      NOW
    );
    if (!selection) throw new Error("expected selection");

    expect(
      isEligibleForFinishEpochWork({
        selection,
        walletAddress: CURRENT,
        isNodeAdmin: true,
      })
    ).toBe(true);
    expect(
      isEligibleForFinishEpochWork({
        selection,
        walletAddress: CURRENT,
        isNodeAdmin: false,
      })
    ).toBe(false);
  });

  it("finalize needs the node-admin decision and a signer wallet in the pinned set; a pinned login wallet alone grants nothing", () => {
    const selection = selectFinishEpochWork(
      [epoch("3", "review", "2026-08-22T00:00:00.000Z", [PINNED])],
      null,
      NOW
    );
    if (!selection) throw new Error("expected selection");

    expect(
      isEligibleForFinishEpochWork({
        selection,
        walletAddress: PINNED.toUpperCase(),
        isNodeAdmin: true,
      })
    ).toBe(true);
    expect(
      isEligibleForFinishEpochWork({
        selection,
        walletAddress: PINNED,
        isNodeAdmin: false,
      })
    ).toBe(false);
    expect(
      isEligibleForFinishEpochWork({
        selection,
        walletAddress: CURRENT,
        isNodeAdmin: true,
      })
    ).toBe(false);
  });
});
