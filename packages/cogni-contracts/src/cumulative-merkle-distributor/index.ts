// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/contracts/cumulative-merkle-distributor`
 * Purpose: Barrel export for the vendored 1inch CumulativeMerkleDrop ABI.
 * Scope: Re-exports the ABI only (the R4 claim-read surface reads merkleRoot,
 *   cumulativeClaimed and calls claim). Bytecode is NOT vendored here — a node
 *   reads/claims against an already-deployed distributor; it never deploys one.
 * Invariants: Must export all public symbols from submodules.
 * Side-effects: none
 * Links: docs/spec/attribution-pipeline-overview.md
 * @public
 */

export { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "./abi";
