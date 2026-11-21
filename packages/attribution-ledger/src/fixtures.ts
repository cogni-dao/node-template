// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Immutable package-boundary fixtures. No database, wallet, network or stored history is mutated. */
export const ATTRIBUTION_CONFORMANCE_INPUT = {
  weightConfig: { "github:pr_merged": 1000, "github:issue_closed": 500 },
  receipts: [
    {
      receiptId: "r10",
      source: "github",
      eventType: "pr_merged",
      included: true,
      weightOverrideMilli: null,
    },
    {
      receiptId: "r2",
      source: "github",
      eventType: "issue_closed",
      included: true,
      weightOverrideMilli: 3n,
    },
    {
      receiptId: "r-excluded",
      source: "github",
      eventType: "pr_merged",
      included: false,
      weightOverrideMilli: null,
    },
  ],
  allocations: [
    {
      claimant: { kind: "user", userId: "10" },
      finalUnits: 3n,
      receiptIds: ["r2", "r10", "r2"],
    },
    {
      claimant: { kind: "user", userId: "2" },
      finalUnits: 3n,
      receiptIds: ["r2"],
    },
    {
      claimant: {
        kind: "identity",
        provider: "github",
        externalId: "42",
        providerLogin: "MiXeD",
      },
      finalUnits: 3n,
      receiptIds: ["r10"],
    },
  ],
  pool: 10n,
  walletA: "0x52908400098527886E0F7030069857D2E4169EE7",
  walletB: "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
} as const;

/** Captured from original commit 5f9d19509f5faccaefcb2084aa88acd2c514bf8b before package rewiring. */
export const ATTRIBUTION_CONFORMANCE_EXPECTED = {
  weights: [
    {
      receiptId: "r10",
      units: "1000",
    },
    {
      receiptId: "r2",
      units: "3",
    },
  ],
  overridden: [
    {
      receiptId: "r10",
      units: "7",
    },
    {
      receiptId: "r2",
      units: "3",
    },
  ],
  statement: [
    {
      claimantKey: "identity:github:42",
      claimant: {
        kind: "identity",
        provider: "github",
        externalId: "42",
        providerLogin: "MiXeD",
      },
      finalUnits: "3",
      poolShare: "0.333333",
      creditAmount: "4",
      receiptIds: ["r10"],
    },
    {
      claimantKey: "user:10",
      claimant: {
        kind: "user",
        userId: "10",
      },
      finalUnits: "3",
      poolShare: "0.333333",
      creditAmount: "3",
      receiptIds: ["r10", "r2"],
    },
    {
      claimantKey: "user:2",
      claimant: {
        kind: "user",
        userId: "2",
      },
      finalUnits: "3",
      poolShare: "0.333333",
      creditAmount: "3",
      receiptIds: ["r2"],
    },
  ],
  finalAllocationSetHash:
    "16155b267be21d6cf3d36065dc83974fef3198f9b032aaacd0b80bf3b217e5ec",
  typedData: {
    domain: {
      name: "Cogni Attribution",
      version: "2",
      chainId: 8453,
    },
    types: {
      AttributionStatement: [
        {
          name: "nodeId",
          type: "string",
        },
        {
          name: "scopeId",
          type: "string",
        },
        {
          name: "epochId",
          type: "string",
        },
        {
          name: "deploymentEnvironment",
          type: "string",
        },
        {
          name: "finalAllocationSetHash",
          type: "string",
        },
        {
          name: "poolTotalCredits",
          type: "string",
        },
      ],
    },
    primaryType: "AttributionStatement",
    message: {
      nodeId: "fixture-node",
      scopeId: "fixture-scope",
      epochId: "15",
      deploymentEnvironment: "candidate-a",
      finalAllocationSetHash:
        "16155b267be21d6cf3d36065dc83974fef3198f9b032aaacd0b80bf3b217e5ec",
      poolTotalCredits: "10",
    },
  },
  echo: {
    nodeId: "fixture-node",
    epochId: "15",
    evaluationRef: "cogni.echo.v0",
    status: "draft",
    algoRef: "echo-v0",
    schemaRef: "cogni.echo.v0/1.0.0",
    inputsHash:
      "6a022153fdf3486f2c2faa6e03d0fcdc585915d42f7d194724f3c28c55cf6c35",
    payloadHash:
      "a891722e7eabc8abfa2f071ba82c49a7319139bbc171ce56667a0877262ee34d",
    payloadJson: {
      totalEvents: 3,
      byEventType: {
        pr_merged: 2,
        issue_closed: 1,
      },
      byUserId: {
        "2": 1,
        "10": 1,
      },
    },
  },
  artifactsHash:
    "d4179e63dc6e6c7a047cdd5361c49ed90686bbf8ffeb103161c1eee50976973f",
  distribution: {
    kind: "cogni.dao_ownership_token_distribution.cumulative.v0",
    merkleTreeLibrary: "openzeppelin/merkle-tree@1",
    claimContractPattern: "1inch.cumulative-merkle-drop.v1",
    distributionId: "fixture",
    nodeId: "fixture-node",
    scopeId: "fixture-scope",
    statementHash:
      "16155b267be21d6cf3d36065dc83974fef3198f9b032aaacd0b80bf3b217e5ec",
    chainId: 8453,
    tokenAddress: "0x52908400098527886E0F7030069857D2E4169EE7",
    merkleRoot:
      "0x4377bfe25c6167739d01e039de9096edb5a6faba567c3c77770ee9e6e118fa5f",
    mintDelta: "3",
    cumulativeTotal: "5",
    leaves: [
      {
        index: 0,
        claimantKey: "user:10",
        account: "0x52908400098527886E0F7030069857D2E4169EE7",
        cumulativeAmount: "3",
        deltaAmount: "1",
        receiptIds: ["r10", "r2"],
        leafHash:
          "0x1bd1325ccbe04cad1ed259f80ede4ddfafe588b40c932de287ba6826c8ac5918",
        proof: [
          "0x2147dc5cf9881634b93d4f5ed3370fa1c004843097301442a5e3ae2f8b5d3ed5",
        ],
      },
      {
        index: 1,
        claimantKey: "user:2",
        account: "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
        cumulativeAmount: "2",
        deltaAmount: "2",
        receiptIds: ["r2"],
        leafHash:
          "0x2147dc5cf9881634b93d4f5ed3370fa1c004843097301442a5e3ae2f8b5d3ed5",
        proof: [
          "0x1bd1325ccbe04cad1ed259f80ede4ddfafe588b40c932de287ba6826c8ac5918",
        ],
      },
    ],
  },
  proofValid: [true, true],
  registry: {
    profiles: ["cogni-v0.0"],
    enrichers: ["cogni.echo.v0"],
    allocators: ["weight-sum-v0"],
    selectionPolicies: [
      "cogni.promotion-selection.v0",
      "cogni.main-merge-selection.v0",
      "cogni.include-all-selection.v0",
    ],
  },
} as const;
