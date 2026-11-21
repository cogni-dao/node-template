// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { ReviewView as SharedReviewView } from "@cogni/knowledge-base-ui/epochs";
import { EpochsBoundary } from "@/features/governance/components/EpochsBoundary";
export function ReviewView(props: {
  readonly walletAddress: string | null;
  readonly isNodeAdmin: boolean;
  readonly operatorSetupUrl: string;
}) {
  return (
    <EpochsBoundary>
      <SharedReviewView {...props} />
    </EpochsBoundary>
  );
}
