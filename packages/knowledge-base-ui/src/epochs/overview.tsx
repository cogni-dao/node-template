// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base-ui/epochs/overview`
 * Purpose: Unified epoch overview with one lifecycle rail for current and historical epochs.
 * Scope: Renders epoch data, settlement evidence, and the existing contribution sync trigger.
 * Invariants: NO_ADMIN_SETTLEMENT_ACTIONS, SAME_RAIL_EVERY_EPOCH, UNKNOWN_NEVER_COMPLETE.
 * Side-effects: IO (via epoch query and contribution sync hooks)
 * Links: src/features/governance/types.ts
 * @public
 */

"use client";

import { useEpochContext } from "./context";

import { CheckCircle, Clock, Eye, Loader2, RefreshCw } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo } from "react";
import {
  Badge,
  Button,
  ExpandableTableRow,
  PieChart,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/index";
import { EpochCountdown } from "./components/EpochCountdown";
import { EpochDetail } from "./components/EpochDetail";
import { EpochLifecycleProgress } from "./components/EpochLifecycleProgress";
import { useCollectEpoch } from "./hooks/useCollectEpoch";
import {
  useEpochsPage,
  useEpochView,
  useSettlementLifecycle,
} from "./hooks/useEpochsPage";
import { buildPieChartData } from "./lib/build-pie-data";
import type { EpochDto } from "./lib/compose-epoch";
import type { SettlementLifecycleEvidence } from "./lib/epoch-lifecycle-state";
import type { EpochView } from "./types";

function compareUnitsDescending(
  left: EpochView["contributors"][number],
  right: EpochView["contributors"][number]
): number {
  const leftUnits = BigInt(left.units);
  const rightUnits = BigInt(right.units);
  return leftUnits === rightUnits ? 0 : leftUnits > rightUnits ? -1 : 1;
}

function formatCredits(value: string | null): string {
  if (value === null) return "—";
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return value;
  }
}

function StatusBadge({
  status,
}: {
  status: EpochView["status"];
}): ReactElement {
  switch (status) {
    case "finalized":
      return (
        <Badge
          intent="outline"
          size="sm"
          className="border-success/40 text-success gap-1"
        >
          <CheckCircle className="h-3 w-3" />
          Finalized
        </Badge>
      );
    case "review":
      return (
        <Badge
          intent="outline"
          size="sm"
          className="border-warning/40 text-warning gap-1"
        >
          <Eye className="h-3 w-3" />
          Review
        </Badge>
      );
    default:
      return (
        <Badge intent="default" size="sm" className="animate-pulse gap-1">
          <Clock className="h-3 w-3" />
          Active
        </Badge>
      );
  }
}

/** Rail slot: renders once the one lifecycle read settles; it never gates the contributor table. */
function LifecycleRail({
  epoch,
  lifecycle,
}: {
  readonly epoch: Pick<EpochView, "id" | "status" | "periodEnd">;
  readonly lifecycle: SettlementLifecycleEvidence | undefined;
}): ReactElement {
  return (
    <div className="bg-card rounded-lg border px-3 py-4">
      {lifecycle ? (
        <EpochLifecycleProgress epoch={epoch} lifecycle={lifecycle} />
      ) : (
        <div className="bg-muted h-16 animate-pulse rounded-md" />
      )}
    </div>
  );
}

function ContributorsSkeleton(): ReactElement {
  return (
    <div className="animate-pulse space-y-4">
      <div className="bg-muted h-44 rounded-lg" />
      <div className="bg-muted h-64 rounded-lg" />
    </div>
  );
}

function CurrentEpochContributors({
  epoch,
}: {
  readonly epoch: EpochView;
}): ReactElement {
  const sorted = useMemo(
    () => [...epoch.contributors].sort(compareUnitsDescending),
    [epoch.contributors]
  );

  const totalPoints = useMemo(
    () =>
      epoch.totalPoints !== undefined
        ? BigInt(epoch.totalPoints).toLocaleString()
        : sorted
            .reduce((sum, contributor) => {
              const roundedPoints = (BigInt(contributor.units) + 500n) / 1000n;
              return sum + roundedPoints;
            }, 0n)
            .toLocaleString(),
    [sorted, epoch.totalPoints]
  );

  const { chartData, chartConfig, legendEntries } = useMemo(
    () =>
      buildPieChartData(
        sorted.map((c) => ({
          key: c.displayName ?? c.claimantLabel,
          value: c.creditShare,
        })),
        (epoch.totalContributorCount ?? sorted.length) > sorted.length
          ? 100
          : undefined
      ),
    [sorted, epoch.totalContributorCount]
  );

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="hidden items-center gap-3 sm:flex">
          <PieChart
            data={chartData}
            config={chartConfig}
            innerRadius={45}
            innerLabel={`#${epoch.id}`}
            className="aspect-square h-44 shrink-0"
          />
          <div className="flex flex-col gap-1.5">
            {legendEntries.map((e) => (
              <div key={e.label} className="flex items-center gap-2 text-xs">
                <div
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: e.color }}
                />
                <span className="text-muted-foreground">{e.label}</span>
              </div>
            ))}
          </div>
        </div>
        <EpochCountdown
          periodStart={epoch.periodStart}
          periodEnd={epoch.periodEnd}
          status={epoch.status}
          contributorCount={epoch.totalContributorCount ?? sorted.length}
          totalPoints={totalPoints}
        />
      </div>

      <EpochDetail epoch={epoch} hideHeader />
    </>
  );
}

function CurrentEpochSection({
  epoch,
  lifecycle,
}: {
  readonly epoch: EpochDto;
  readonly lifecycle: SettlementLifecycleEvidence | undefined;
}): ReactElement {
  const collectEpoch = useCollectEpoch();
  const view = useEpochView(epoch);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="mb-1 text-3xl font-bold tracking-tight">
            Epoch <span className="text-primary">#{epoch.id}</span>
          </h1>
          <p className="text-muted-foreground">
            {new Date(epoch.periodStart).toLocaleDateString()} —{" "}
            {new Date(epoch.periodEnd).toLocaleDateString()}
          </p>
        </div>

        {epoch.status === "open" ? (
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              disabled={
                collectEpoch.loading || collectEpoch.cooldownSeconds !== null
              }
              aria-busy={collectEpoch.loading}
              aria-describedby={
                collectEpoch.error ||
                collectEpoch.successMessage ||
                collectEpoch.cooldownSeconds !== null
                  ? "epoch-sync-feedback"
                  : undefined
              }
              onClick={() => void collectEpoch.trigger()}
            >
              {collectEpoch.loading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-4" aria-hidden="true" />
              )}
              {collectEpoch.loading ? "Syncing…" : "Sync contributions"}
            </Button>
            {collectEpoch.error ? (
              <p
                id="epoch-sync-feedback"
                role="alert"
                className="text-destructive max-w-sm text-xs sm:text-right"
              >
                Couldn’t sync contributions: {collectEpoch.error}
              </p>
            ) : collectEpoch.successMessage ? (
              <p
                id="epoch-sync-feedback"
                role="status"
                className="text-success max-w-sm text-xs sm:text-right"
              >
                {collectEpoch.successMessage}
              </p>
            ) : collectEpoch.cooldownSeconds !== null ? (
              <p
                id="epoch-sync-feedback"
                role="status"
                className="text-muted-foreground max-w-sm text-xs sm:text-right"
              >
                Recently synced. Try again in about{" "}
                {Math.ceil(collectEpoch.cooldownSeconds / 60)} min.
              </p>
            ) : (
              <p className="text-muted-foreground max-w-sm text-xs sm:text-right">
                Pull the latest contributions into this open epoch.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <LifecycleRail epoch={epoch} lifecycle={lifecycle} />

      {view.error ? (
        <div className="border-destructive bg-destructive/10 rounded-lg border p-6">
          <h2 className="text-destructive text-lg font-semibold">
            Error loading epoch contributions
          </h2>
          <p className="text-muted-foreground text-sm">{view.error.message}</p>
        </div>
      ) : view.data ? (
        <CurrentEpochContributors epoch={view.data} />
      ) : (
        <ContributorsSkeleton />
      )}
    </div>
  );
}

/** Mounted only when the row is opened, so a past epoch is read on demand. */
function PastEpochDetail({
  epoch,
  lifecycle,
}: {
  readonly epoch: EpochDto;
  readonly lifecycle: SettlementLifecycleEvidence | undefined;
}): ReactElement {
  const view = useEpochView(epoch);
  return (
    <div className="space-y-4">
      <LifecycleRail epoch={epoch} lifecycle={lifecycle} />
      {view.error ? (
        <p role="alert" className="text-destructive text-sm">
          Couldn’t load this epoch: {view.error.message}
        </p>
      ) : view.data ? (
        <EpochDetail epoch={view.data} />
      ) : (
        <ContributorsSkeleton />
      )}
    </div>
  );
}

function PastEpochsSection({
  epochs,
  lifecycle,
}: {
  readonly epochs: readonly EpochDto[];
  readonly lifecycle: SettlementLifecycleEvidence | undefined;
}): ReactElement {
  const { state, setState } = useEpochContext();
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead className="w-16">#</TableHead>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Credits</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {epochs.map((epoch) => {
            return (
              <ExpandableTableRow
                key={epoch.id}
                expanded={(
                  state.expandedEpochIds ??
                  (state.selectedEpochId ? [state.selectedEpochId] : [])
                ).includes(epoch.id)}
                onExpandedChange={(expanded) => {
                  const open =
                    state.expandedEpochIds ??
                    (state.selectedEpochId ? [state.selectedEpochId] : []);
                  const next = expanded
                    ? [...new Set([...open, epoch.id])]
                    : open.filter((id) => id !== epoch.id);
                  setState({
                    ...state,
                    expandedEpochIds: next,
                    selectedEpochId: next[next.length - 1] ?? null,
                  });
                }}
                colSpan={5}
                cellClassNames={[
                  undefined,
                  undefined,
                  "text-right",
                  "text-right",
                ]}
                expandedContent={
                  <PastEpochDetail epoch={epoch} lifecycle={lifecycle} />
                }
                cells={[
                  <span key="id" className="text-foreground/60 font-bold">
                    {epoch.id}
                  </span>,
                  <span key="period" className="text-sm">
                    {new Date(epoch.periodStart).toLocaleDateString()} —{" "}
                    {new Date(epoch.periodEnd).toLocaleDateString()}
                  </span>,
                  <span key="credits" className="text-right font-mono text-xs">
                    {formatCredits(epoch.poolTotalCredits)}
                  </span>,
                  <div key="status" className="flex justify-end">
                    <StatusBadge status={epoch.status} />
                  </div>,
                ]}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function CurrentEpochView(): ReactElement {
  const { state, setState } = useEpochContext();
  const { data, isLoading, error } = useEpochsPage();
  const lifecycle = useSettlementLifecycle().data;

  if (error) {
    return (
      <div className="flex flex-col gap-8">
        <div className="border-destructive bg-destructive/10 rounded-lg border p-6">
          <h2 className="text-destructive text-lg font-semibold">
            Error loading epoch data
          </h2>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-8">
        <div className="animate-pulse space-y-8">
          <div className="bg-muted h-8 w-48 rounded-md" />
          <div className="bg-muted h-28 rounded-lg" />
          <div className="bg-muted h-64 rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {data.current ? (
        <CurrentEpochSection
          key={data.current.id}
          epoch={data.current}
          lifecycle={lifecycle}
        />
      ) : (
        <div className="bg-card rounded-lg border p-12 text-center">
          <p className="text-muted-foreground">No active epoch</p>
          <p className="text-muted-foreground mt-2 text-sm">
            A new epoch will appear here when one is opened.
          </p>
        </div>
      )}

      {data.pastEpochs.length > 0 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">
              Past Epochs
            </h2>
            <p className="text-muted-foreground text-sm">
              Review and finalized epochs. Open a row to load its distribution
              state.
            </p>
          </div>
          <PastEpochsSection epochs={data.pastEpochs} lifecycle={lifecycle} />
          {(data.historyTotal > 200 || state.historyOffset > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Button
                disabled={state.historyOffset === 0}
                onClick={() =>
                  setState({
                    ...state,
                    historyOffset: Math.max(0, state.historyOffset - 200),
                  })
                }
              >
                Previous epochs
              </Button>
              <span>
                {state.historyOffset + 1}–
                {Math.min(state.historyOffset + 200, data.historyTotal)} of{" "}
                {data.historyTotal}
              </span>
              <Button
                disabled={state.historyOffset + 200 >= data.historyTotal}
                onClick={() =>
                  setState({
                    ...state,
                    historyOffset: state.historyOffset + 200,
                  })
                }
              >
                More epochs
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
