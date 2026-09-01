// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `epoch-page-wiring.test`
 * Purpose: Prove the Epoch overview is read-only and uses one rail for current and historical epochs.
 * Scope: App-view composition with visual children and the page query mocked.
 * Invariants: EPOCH_OVERVIEW_READ_ONLY, SAME_RAIL_EVERY_EPOCH, ADMIN_ACTIONS_LIVE_IN_REVIEW.
 * Side-effects: none
 * Links: src/app/(app)/gov/epoch/view.tsx, task.5039
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { EpochView } from "@/features/governance/types";

const epochs = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("@/features/governance/hooks/useEpochsPage", () => ({
  useEpochsPage: () => ({ data: epochs.data, isLoading: false, error: null }),
}));
vi.mock("@/features/governance/components/EpochCountdown", () => ({
  EpochCountdown: () => <div>Epoch countdown</div>,
}));
vi.mock("@/features/governance/components/EpochDetail", () => ({
  EpochDetail: ({ epoch }: { epoch: EpochView }) => (
    <div data-testid={`detail-${epoch.id}`}>Epoch detail</div>
  ),
}));
vi.mock("@/features/governance/components/EpochLifecycleProgress", () => ({
  EpochLifecycleProgress: ({ epoch }: { epoch: EpochView }) => (
    <div data-testid={`rail-${epoch.id}`}>Lifecycle rail</div>
  ),
}));
vi.mock("@/components", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ExpandableTableRow: ({
    cells,
    expandedContent,
  }: {
    cells: ReactNode[];
    expandedContent: ReactNode;
  }) => (
    <div>
      {cells}
      {expandedContent}
    </div>
  ),
  PieChart: () => null,
  Table: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableHead: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { CurrentEpochView } from "@/app/(app)/gov/epoch/view";

function epoch(id: string, status: EpochView["status"]): EpochView {
  return {
    id,
    status,
    periodStart: "2026-08-10T00:00:00.000Z",
    periodEnd: "2026-08-17T00:00:00.000Z",
    poolTotalCredits: status === "finalized" ? "100" : null,
    approvers: status === "open" ? null : ["0xapprover"],
    contributors: [],
    unresolvedCount: 0,
    unresolvedActivities: [],
  };
}

describe("Epoch page wiring", () => {
  it("shows current and historical rails without mutation controls", () => {
    const current = epoch("8", "open");
    const past = epoch("7", "finalized");
    epochs.data = {
      current,
      pastEpochs: [past],
      settlementLifecycle: {
        publicationEvidence: "matched",
        liveRevision: null,
        latestRevision: null,
        epochs: [],
      },
    };

    render(<CurrentEpochView />);

    expect(screen.getByTestId("rail-8")).toBeInTheDocument();
    expect(screen.getByTestId("rail-7")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/publish distribution/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open for review/i)).not.toBeInTheDocument();
  });
});
