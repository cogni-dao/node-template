// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { encodeFunctionData, keccak256, toBytes } from "viem";
export const EXECUTE_PERMISSION_ID = keccak256(
  toBytes("EXECUTE_PERMISSION")
) as `0x${string}`;

export const DAO_ABI = [
  {
    type: "function",
    name: "hasPermission",
    stateMutability: "view",
    inputs: [
      { name: "_where", type: "address", internalType: "address" },
      { name: "_who", type: "address", internalType: "address" },
      { name: "_permissionId", type: "bytes32", internalType: "bytes32" },
      { name: "_data", type: "bytes", internalType: "bytes" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_callId", type: "bytes32", internalType: "bytes32" },
      {
        name: "_actions",
        type: "tuple[]",
        internalType: "struct Action[]",
        components: [
          { name: "to", type: "address", internalType: "address" },
          { name: "value", type: "uint256", internalType: "uint256" },
          { name: "data", type: "bytes", internalType: "bytes" },
        ],
      },
      { name: "_allowFailureMap", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      { name: "", type: "bytes[]", internalType: "bytes[]" },
      { name: "", type: "uint256", internalType: "uint256" },
    ],
  },
] as const;

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

export type PublishPermissionState = "authorized" | "none" | "loading";

/** Only strict compare-and-swap authority passes; every other permission shape fails closed. */
export function classifyPublishPermission(
  validProbe: boolean | undefined,
  invalidFailureProbe: boolean | undefined
): PublishPermissionState {
  if (validProbe === undefined || invalidFailureProbe === undefined) {
    return "loading";
  }
  if (validProbe && !invalidFailureProbe) return "authorized";
  return "none";
}
