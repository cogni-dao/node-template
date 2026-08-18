// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/distribution-publish-cas`
 * Purpose: Build and classify deterministic permission probes for publish CAS V2.
 * Scope: Pure calldata helpers; no React, wallet, RPC, or chain IO.
 * Invariants: EXPECTED_ROOT_IS_CALL_ID, ZERO_FAILURE_MAP, LEGACY_FAILS_CLOSED.
 * Side-effects: none
 * Links: hooks/useExecuteDistribution.ts,
 *   packages/cogni-contracts/src/distribution-publish-condition/DistributionPublishCondition.sol
 * @public
 */

import { encodeFunctionData } from "viem";

import { DAO_ABI } from "@/features/governance/lib/proposal-abis";

const MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [],
  },
] as const;
const SET_MERKLE_ROOT_ABI = [
  {
    type: "function",
    name: "setMerkleRoot",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }],
    outputs: [],
  },
] as const;
const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const PROBE_NEXT_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

/** Build a representative strict publish payload for DAO.hasPermission. */
export function buildPublishProbeData(
  token: `0x${string}`,
  distributor: `0x${string}`,
  expectedRoot: `0x${string}`,
  allowFailureMap: bigint
): `0x${string}` {
  const nextRoot =
    expectedRoot.toLowerCase() === PROBE_NEXT_ROOT.toLowerCase()
      ? ZERO_ROOT
      : PROBE_NEXT_ROOT;
  const mintData = encodeFunctionData({
    abi: MINT_ABI,
    functionName: "mint",
    args: [distributor, 0n],
  });
  const rootData = encodeFunctionData({
    abi: SET_MERKLE_ROOT_ABI,
    functionName: "setMerkleRoot",
    args: [nextRoot],
  });
  return encodeFunctionData({
    abi: DAO_ABI,
    functionName: "execute",
    args: [
      expectedRoot,
      [
        { to: token, value: 0n, data: mintData },
        { to: distributor, value: 0n, data: rootData },
      ],
      allowFailureMap,
    ],
  });
}

export type PublishPermissionState =
  | "cas_v2"
  | "legacy_or_unscoped"
  | "none"
  | "loading";

/** Paired probes distinguish strict V2 from legacy or unconditional authority. */
export function classifyPublishPermission(
  validProbe: boolean | undefined,
  invalidFailureProbe: boolean | undefined
): PublishPermissionState {
  if (validProbe === undefined || invalidFailureProbe === undefined) {
    return "loading";
  }
  if (validProbe && !invalidFailureProbe) return "cas_v2";
  if (validProbe && invalidFailureProbe) return "legacy_or_unscoped";
  return "none";
}
