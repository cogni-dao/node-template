// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { CurrentEpochView as SharedCurrentEpochView } from "@cogni/knowledge-base-ui/epochs";
import { EpochsBoundary } from "@/features/governance/components/EpochsBoundary";
export function CurrentEpochView() {
  return (
    <EpochsBoundary>
      <SharedCurrentEpochView />
    </EpochsBoundary>
  );
}
