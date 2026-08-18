// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/proposal-abis`
 * Purpose: Contract ABIs and pure calldata builders for DAO proposal execution.
 * Scope: ABI definitions and deterministic encoding only — no contract calls, no state.
 * Invariants: ABIs must match deployed contract versions.
 * Side-effects: none
 * Links: cogni-proposal-launcher/src/lib/abis.ts
 * @public
 */

import { encodeFunctionData, keccak256, toBytes } from "viem";

/**
 * Aragon OSx permission id for the DAO's `execute` entrypoint:
 * `keccak256("EXECUTE_PERMISSION")`. A wallet holding this on the DAO (where=DAO,
 * who=wallet) may call `DAO.execute(...)` directly — the standing authority the
 * ONE-TIME authorize grants, so per-epoch publishing needs no vote.
 */
export const EXECUTE_PERMISSION_ID = keccak256(
  toBytes("EXECUTE_PERMISSION")
) as `0x${string}`;

export const COGNI_SIGNAL_ABI = [
  {
    type: "function",
    name: "signal",
    inputs: [
      { name: "vcs", type: "string", internalType: "string" },
      { name: "repoUrl", type: "string", internalType: "string" },
      { name: "action", type: "string", internalType: "string" },
      { name: "target", type: "string", internalType: "string" },
      { name: "resource", type: "string", internalType: "string" },
      { name: "extra", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const TOKEN_VOTING_ABI = [
  {
    type: "function",
    name: "createProposal",
    inputs: [
      { name: "_metadata", type: "bytes", internalType: "bytes" },
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
      {
        name: "_allowFailureMap",
        type: "uint256",
        internalType: "uint256",
      },
      { name: "_startDate", type: "uint64", internalType: "uint64" },
      { name: "_endDate", type: "uint64", internalType: "uint64" },
      {
        name: "_voteOption",
        type: "uint8",
        internalType: "enum IMajorityVoting.VoteOption",
      },
      { name: "_tryEarlyExecution", type: "bool", internalType: "bool" },
    ],
    outputs: [{ name: "proposalId", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Aragon OSx DAO minimal ABI — the functions the publish surface needs:
 *   - `hasPermission`      (view) — gate the two-state UI on whether the wallet is authorized.
 *   - `grantWithCondition` (nonpayable) — the ONE-TIME SCOPED authorize action (wrapped in a
 *     createProposal so the DAO grants EXECUTE_PERMISSION on itself to the executor, bound to a
 *     DistributionPublishCondition so the grant only permits the publish action set).
 *   - `revoke`             (nonpayable) — removes a legacy shape-only grant before V2 regrant.
 *   - `execute`            (nonpayable) — the PER-EPOCH direct publish, callable once the wallet
 *     holds EXECUTE_PERMISSION; runs [mint, setMerkleRoot] atomically as msg.sender=DAO.
 * Source: Aragon OSx v1.3 `DAO.sol` (IDAO). Kept minimal — reads/writes only what publish uses.
 */
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
    name: "revoke",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_where", type: "address", internalType: "address" },
      { name: "_who", type: "address", internalType: "address" },
      { name: "_permissionId", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [],
  },
  {
    // SCOPED authorize: bind the executor's EXECUTE_PERMISSION to a condition contract so
    // the grant only permits the publish action set. Executes AS the DAO inside the proposal.
    type: "function",
    name: "grantWithCondition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_where", type: "address", internalType: "address" },
      { name: "_who", type: "address", internalType: "address" },
      { name: "_permissionId", type: "bytes32", internalType: "bytes32" },
      {
        name: "_condition",
        type: "address",
        internalType: "contract IPermissionCondition",
      },
    ],
    outputs: [],
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

/** Build the atomic migration proposal: revoke legacy/unset authority, then grant CAS V2. */
export function buildPublishAuthorizationProposalArgs(
  dao: `0x${string}`,
  wallet: `0x${string}`,
  condition: `0x${string}`
) {
  const revokeData = encodeFunctionData({
    abi: DAO_ABI,
    functionName: "revoke",
    args: [dao, wallet, EXECUTE_PERMISSION_ID],
  });
  const grantData = encodeFunctionData({
    abi: DAO_ABI,
    functionName: "grantWithCondition",
    args: [dao, wallet, EXECUTE_PERMISSION_ID, condition],
  });

  return [
    "0x", // _metadata
    [
      { to: dao, value: 0n, data: revokeData },
      { to: dao, value: 0n, data: grantData },
    ],
    0n, // _allowFailureMap: revoke + grant are atomic
    0n, // _startDate (0 ⇒ plugin derives)
    0n, // _endDate (0 ⇒ plugin derives)
    2, // _voteOption: IMajorityVoting.VoteOption.Yes
    true, // _tryEarlyExecution
  ] as const;
}
