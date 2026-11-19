// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/_lib/attribution-dto`
 * Purpose: DTO mappers for ledger domain types to contract wire format.
 * Scope: BigInt/Date → string conversion for JSON serialization. No business logic. Does not perform I/O or validation.
 * Invariants: ALL_MATH_BIGINT — all bigint values serialized as strings.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/read/dto.ts (moved to @cogni-dao/attribution, story.0076), contracts/attribution.*.v1.contract
 * @internal
 */

export {
  toEpochDto,
  toIngestionReceiptDto,
  toPoolComponentDto,
  toSelectionDto,
  toStatementDto,
  toUserProjectionDto,
} from "@cogni/attribution-ledger";
