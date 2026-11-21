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

/**
 * Aragon OSx permission id for the DAO's `execute` entrypoint:
 * `keccak256("EXECUTE_PERMISSION")`. A wallet holding this on the DAO (where=DAO,
 * who=wallet) may call `DAO.execute(...)` directly — the standing authority the
 * operator grants during one-time setup, so per-epoch publishing needs no vote.
 */
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

/** Aragon TokenVoting proposal creation used by the public merge-proposal flow. */
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
 *   - `hasPermission` (view) — gate the two-state UI on whether the wallet has strict CAS authority.
 *   - `execute`            (nonpayable) — the PER-EPOCH direct publish, callable once the wallet
 *     holds EXECUTE_PERMISSION; runs [mint, setMerkleRoot] atomically as msg.sender=DAO.
 * Source: Aragon OSx v1.3 `DAO.sol` (IDAO). Kept minimal — reads/writes only what publish uses.
 */

export {
  DAO_ABI,
  EXECUTE_PERMISSION_ID,
  buildPublishProbeData,
  classifyPublishPermission,
  type PublishPermissionState,
} from "@cogni/attribution-ledger/distribution/publish-permission";
