// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readFinalizedEpochClaimants as read } from "@cogni/attribution-ledger/http";
import { getContainer } from "@/bootstrap/container";
export function readFinalizedEpochClaimants(epochId: bigint) {
  return read(getContainer().attributionStore, epochId);
}
