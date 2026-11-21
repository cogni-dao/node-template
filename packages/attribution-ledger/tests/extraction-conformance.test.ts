// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, it, expect } from "vitest";
import * as ledger from "../src/index";
import {
  createEchoAdapter,
  createDefaultRegistries,
} from "../src/pipeline/index";
import {
  buildDaoTokenCumulativeDistribution,
  verifyCumulativeMerkleProof,
} from "../src/distribution/index";
import {
  ATTRIBUTION_CONFORMANCE_INPUT as input,
  ATTRIBUTION_CONFORMANCE_EXPECTED as expected,
} from "../src/fixtures";

describe("published attribution extraction", () => {
  it("matches original frozen algorithm bytes and registry at5f9d195", async () => {
    const weights = ledger.computeReceiptWeights(
      "weight-sum-v0",
      input.receipts,
      input.weightConfig
    );
    const overrides = [
      {
        subjectRef: "r10",
        overrideUnits: 7n,
        overrideShares: null,
        overrideReason: "fixture",
      },
    ];
    const overridden = ledger.applyReceiptWeightOverrides(weights, overrides);
    const allocations = input.allocations;
    const statement = ledger.computeAttributionStatementLines(
      allocations,
      input.pool
    );
    const finalAllocationSetHash =
      await ledger.computeFinalClaimantAllocationSetHash(allocations);
    const typedData = ledger.buildEIP712TypedData({
      nodeId: "fixture-node",
      scopeId: "fixture-scope",
      epochId: "15",
      finalAllocationSetHash,
      poolTotalCredits: input.pool.toString(),
      chainId: 8453,
      deploymentEnvironment: "candidate-a",
    });
    const selected = input.receipts.map((r, i) => ({
      ...r,
      userId: i === 1 ? null : String(i === 0 ? 10 : 2),
      platformUserId: String(i),
      platformLogin: i === 1 ? null : "MiXeD",
      payloadHash: `hash${i}`,
      metadata: { title: r.receiptId },
    }));
    const echo = await createEchoAdapter().evaluateDraft({
      nodeId: "fixture-node",
      epochId: 15n,
      attributionStore: {
        getSelectedReceiptsWithMetadata: async () => selected,
      },
    } as never);
    const artifactsHash = await ledger.computeArtifactsHash([echo]);
    const registries = createDefaultRegistries({
      excludedLogins: ["bot"],
      sourceRefs: ["Cogni-DAO/node-template"],
    });
    const distribution = buildDaoTokenCumulativeDistribution({
      distributionId: "fixture",
      nodeId: "fixture-node",
      scopeId: "fixture-scope",
      statementHash: finalAllocationSetHash,
      chainId: 8453,
      tokenAddress: input.walletA,
      priorCumulative: [
        {
          claimantKey: "user:10",
          account: input.walletA,
          cumulativeAmount: 2n,
        },
      ],
      epochDeltas: [
        {
          claimantKey: "user:10",
          account: input.walletA,
          deltaAmount: 1n,
          receiptIds: ["r10", "r2", "r2"],
        },
        {
          claimantKey: "user:2",
          account: input.walletB,
          deltaAmount: 2n,
          receiptIds: ["r2"],
        },
      ],
    });
    const proofValid = distribution.leaves.map((leaf) =>
      verifyCumulativeMerkleProof(
        leaf.leafHash,
        leaf.proof,
        distribution.merkleRoot
      )
    );
    const result = {
      weights,
      overridden,
      statement,
      finalAllocationSetHash,
      typedData,
      echo,
      artifactsHash,
      distribution,
      proofValid,
      registry: {
        profiles: [...registries.profiles.keys()],
        enrichers: [...registries.enrichers.keys()],
        allocators: [...registries.allocators.keys()],
        selectionPolicies: [...registries.selectionPolicies.keys()],
      },
    };
    expect(
      JSON.parse(
        JSON.stringify(result, (_, value) =>
          typeof value === "bigint" ? value.toString() : value
        )
      )
    ).toEqual(expected);
  });
});
