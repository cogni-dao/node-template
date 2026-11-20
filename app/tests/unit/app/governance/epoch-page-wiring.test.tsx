// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `epoch-page-wiring.test`
 * Purpose: Prove the Epoch overview keeps contribution sync while admin settlement actions stay in Review.
 * Scope: App-view composition with visual children and the page query mocked.
 * Invariants: CONTRIBUTION_SYNC_REMAINS, SAME_RAIL_EVERY_EPOCH, ADMIN_ACTIONS_LIVE_IN_REVIEW.
 * Side-effects: none
 * Links: src/app/(app)/gov/epoch/view.tsx, task.5039
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EpochDto } from "@/features/governance/lib/compose-epoch";
import type { EpochView } from "@/features/governance/types";

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  lifecycle: undefined as unknown,
  views: {} as Record<string, unknown>,
  viewReads: [] as { id: string; enabled: boolean }[],
  collect: {
    loading: false,
    error: null as string | null,
    successMessage: null as string | null,
    cooldownSeconds: null as number | null,
    trigger: vi.fn(),
  },
}));

vi.mock("@/features/governance/hooks/useEpochsPage", () => ({
  useEpochsPage: () => ({ data: state.data, isLoading: false, error: null }),
  useSettlementLifecycle: () => ({ data: state.lifecycle }),
  useEpochView: (epoch: { id: string }, options?: { enabled?: boolean }) => {
    state.viewReads.push({ id: epoch.id, enabled: options?.enabled ?? true });
    return { data: state.views[epoch.id], error: null };
  },
}));
vi.mock("@/features/governance/hooks/useCollectEpoch", () => ({
  useCollectEpoch: () => state.collect,
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
  Button: ({
    children,
    className,
    disabled,
    onClick,
    type,
    "aria-busy": ariaBusy,
    "aria-describedby": ariaDescribedBy,
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => (
    <button
      type={type}
      className={className}
      disabled={disabled}
      onClick={onClick}
      aria-busy={ariaBusy}
      aria-describedby={ariaDescribedBy}
    >
      {children}
    </button>
  ),
  // Like the real row: expanded content mounts only after the row is opened.
  ExpandableTableRow: ({
    cells,
    expandedContent,
  }: {
    cells: ReactNode[];
    expandedContent: ReactNode;
  }) => {
    const [expanded, setExpanded] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setExpanded((p) => !p)}>
          toggle row
        </button>
        {cells}
        {expanded ? expandedContent : null}
      </div>
    );
  },
  PieChart: () => null,
  Table: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableHead: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { CurrentEpochView } from "@/app/(app)/gov/epoch/view";

function epoch(id: string, status: EpochView["status"]): EpochDto {
  return {
    id,
    status,
    periodStart: "2026-08-10T00:00:00.000Z",
    periodEnd: "2026-08-17T00:00:00.000Z",
    weightConfig: {},
    poolTotalCredits: status === "finalized" ? "100" : null,
  };
}

function view(id: string, status: EpochView["status"]): EpochView {
  return {
    id,
    status,
    periodStart: "2026-08-10T00:00:00.000Z",
    periodEnd: "2026-08-17T00:00:00.000Z",
    poolTotalCredits: status === "finalized" ? "100" : null,
    contributors: [],
    unresolvedCount: 0,
    unresolvedActivities: [],
  };
}

const matched = {
  publicationEvidence: "matched",
  liveRevision: null,
  latestRevision: null,
  epochs: [],
};
const unknown = { ...matched, publicationEvidence: "unknown" };

beforeEach(() => {
  state.views = {};
  state.viewReads = [];
  state.lifecycle = matched;
});

describe("Epoch page wiring", () => {
  it("shows lifecycle rails and contribution sync without admin settlement controls", () => {
    state.data = {
      current: epoch("8", "open"),
      pastEpochs: [epoch("7", "finalized")],
    };
    state.views = { "8": view("8", "open"), "7": view("7", "finalized") };

    render(<CurrentEpochView />);
    fireEvent.click(screen.getByRole("button", { name: "toggle row" }));

    expect(screen.getByTestId("rail-8")).toBeInTheDocument();
    expect(screen.getByTestId("rail-7")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sync contributions" })
    ).toBeInTheDocument();
    expect(screen.queryByText(/publish distribution/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open for review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sign and finalize/i)).not.toBeInTheDocument();
  });

  it("shows cooldown feedback and disables repeat sync", () => {
    state.collect.cooldownSeconds = 125;
    state.data = { current: epoch("8", "open"), pastEpochs: [] };
    state.views = { "8": view("8", "open") };
    state.lifecycle = unknown;

    render(<CurrentEpochView />);

    expect(
      screen.getByRole("button", { name: "Sync contributions" })
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Recently synced. Try again in about 3 min."
    );
    state.collect.cooldownSeconds = null;
  });

  it("does not show contribution sync after the epoch enters review", () => {
    state.data = { current: epoch("8", "review"), pastEpochs: [] };
    state.views = { "8": view("8", "review") };
    state.lifecycle = unknown;

    render(<CurrentEpochView />);

    expect(
      screen.queryByRole("button", { name: "Sync contributions" })
    ).not.toBeInTheDocument();
  });

  it("shows the past-epochs table and the rail before the current contributor table loads, and reads a past epoch only when its row opens", () => {
    state.data = {
      current: epoch("8", "open"),
      pastEpochs: [epoch("7", "review"), epoch("6", "finalized")],
    };
    // No view cached yet for any epoch: the current epoch's contributions are still loading.

    render(<CurrentEpochView />);

    expect(screen.getByTestId("rail-8")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-8")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "toggle row" })).toHaveLength(
      2
    );
    // Collapsed past rows read nothing: only the current epoch's view is requested.
    expect(state.viewReads.every((read) => read.id === "8")).toBe(true);

    state.viewReads = [];
    fireEvent.click(screen.getAllByRole("button", { name: "toggle row" })[0]);
    expect(state.viewReads.some((read) => read.id === "7")).toBe(true);
    expect(state.viewReads.some((read) => read.id === "6")).toBe(false);
  });

  it("holds the rail on a skeleton until the one lifecycle read settles", () => {
    state.data = { current: epoch("8", "open"), pastEpochs: [] };
    state.lifecycle = undefined;

    render(<CurrentEpochView />);

    expect(screen.queryByTestId("rail-8")).not.toBeInTheDocument();
  });
});
