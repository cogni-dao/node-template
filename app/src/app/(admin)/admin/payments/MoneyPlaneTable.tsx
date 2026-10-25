// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `admin/payments/MoneyPlaneTable`
 * Purpose: Node-owned Financials with separate treasury/custody and scoped cost-rate cohorts.
 * Scope: Client presentation of an authorized server report; no provider reads or payments.
 * Invariants: Native units/custody remain separate; missing last; no inferred payment history.
 * Side-effects: local sort state, route refresh
 * Links: packages/money-plane/src/summarize.ts
 * @public
 */
"use client";

import {
  type CostRateEvidence,
  type Grade,
  type MoneyPlaneRow,
  summarizeCostRates,
} from "@cogni/money-plane";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  type Row,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  Button,
  DataGrid,
  DataGridColumnHeader,
  DataGridContainer,
  DataGridTable,
  StatusBadge,
} from "@/components";

const STATUS = {
  RED: { label: "Low", variant: "destructive-light", rank: 0 },
  YELLOW: { label: "Watch", variant: "warning-light", rank: 1 },
  UNKNOWN: { label: "Missing", variant: "outline", rank: 2 },
  GREEN: { label: "OK", variant: "success-light", rank: 3 },
  INFO: { label: "Holding", variant: "info-light", rank: 4 },
} as const satisfies Record<
  Grade,
  { label: string; variant: string; rank: number }
>;

function measured(value: number | null | undefined): number | undefined {
  return value != null && Number.isFinite(value) ? value : undefined;
}
function numberText(value: string | number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (number !== 0 && Math.abs(number) < 0.01) return number.toPrecision(3);
  return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function amount(value: number | null, currency: string | null): string {
  return measured(value) === undefined
    ? "—"
    : `${numberText(value ?? 0)} ${currency ?? ""}`.trim();
}
function rateText(
  value: string | number,
  currency: string,
  per: string
): string {
  return currency === "uact"
    ? `${numberText(Number(value) / 1_000_000)} USD credit/${per}`
    : `${numberText(value)} ${currency}/${per}`;
}
function burn(row: MoneyPlaneRow) {
  if (row.kind === "wallet" || row.kind === "expiry") return undefined;
  if (row.nativeRate)
    return {
      value: measured(Number(row.nativeRate.amount)),
      currency: row.nativeRate.currency,
      per: row.nativeRate.per,
    };
  return {
    value: measured(row.burnPerDay),
    currency: row.currency ?? "",
    per: "day",
  };
}
function nativeSort(
  a: Row<MoneyPlaneRow>,
  b: Row<MoneyPlaneRow>,
  id: string,
  instruments: ReadonlyMap<string, string | null>
): number {
  const group = (row: MoneyPlaneRow) => {
    const instrument = instruments.get(row.plane);
    return JSON.stringify([
      instrument ? "instrument" : "source",
      instrument ?? row.plane,
      id === "rate" ? (burn(row)?.currency ?? "") : (row.currency ?? ""),
      id === "rate" ? (burn(row)?.per ?? "") : "",
    ]);
  };
  return (
    group(a.original).localeCompare(group(b.original)) ||
    a.getValue<number>(id) - b.getValue<number>(id)
  );
}

const column = createColumnHelper<MoneyPlaneRow>();
export function createMoneyPlaneColumns(
  rateEvidence: readonly CostRateEvidence[] = []
) {
  const instrumentBySource = new Map(
    rateEvidence.map((item) => [item.sourceId, item.instrumentId])
  );
  const basisBySource = new Map(
    rateEvidence.map((item) => [item.sourceId, item.basis])
  );
  return [
    column.accessor("label", {
      id: "service",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Service" />
      ),
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <span>{row.original.label}</span>
            <div className="text-muted-foreground text-xs">
              {row.original.beneficiary ?? "Scope unknown"}
            </div>
          </div>
          {row.original.kind !== "wallet" &&
          row.original.coverage === "operator-covered" ? (
            <StatusBadge variant="outline">Sponsored</StatusBadge>
          ) : null}
        </div>
      ),
    }),
    column.accessor((row) => measured(row.balance), {
      id: "balance",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Balance / credit" />
      ),
      sortUndefined: "last",
      sortingFn: (a, b, id) => nativeSort(a, b, id, instrumentBySource),
      cell: ({ row }) => amount(row.original.balance, row.original.currency),
    }),
    column.accessor((row) => burn(row)?.value, {
      id: "rate",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Rate" />
      ),
      sortUndefined: "last",
      sortingFn: (a, b, id) => nativeSort(a, b, id, instrumentBySource),
      cell: ({ row }) => {
        const rate = burn(row.original);
        return rate?.value === undefined ? (
          "—"
        ) : (
          <div>
            {rateText(rate.value, rate.currency, rate.per)}
            <div className="text-muted-foreground text-xs">
              {basisBySource.get(row.original.plane)?.kind === "contract"
                ? "Contract rate"
                : basisBySource.get(row.original.plane)?.kind === "measured"
                  ? "Measured burn"
                  : "Basis unknown"}
            </div>
          </div>
        );
      },
    }),
    column.accessor((row) => measured(row.runwayDays), {
      id: "runway",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Runway" />
      ),
      sortUndefined: "last",
      cell: ({ getValue }) =>
        getValue() === undefined ? "—" : `${numberText(getValue() ?? 0)} d`,
    }),
    column.accessor("payer", {
      id: "payer",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Funded by" />
      ),
      cell: ({ row }) => row.original.payer ?? "Unknown",
    }),
    column.accessor((row) => STATUS[row.grade].rank, {
      id: "status",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => (
        <StatusBadge variant={STATUS[row.original.grade].variant}>
          {STATUS[row.original.grade].label}
        </StatusBadge>
      ),
    }),
    column.display({
      id: "details",
      header: "",
      cell: ({ row }) => <EvidenceDetails row={row.original} />,
    }),
  ];
}
export const moneyPlaneColumns = createMoneyPlaneColumns();

function EvidenceDetails({ row }: { row: MoneyPlaneRow }) {
  return (
    <details>
      <summary aria-label={`Details for ${row.label}`}>Details</summary>
      <dl className="grid gap-1 py-2">
        {row.kind === "wallet" ? (
          <>
            <dt>Configured account roles</dt>
            <dd>{row.label}</dd>
          </>
        ) : null}
        <dt>Source</dt>
        <dd>{row.source ?? "Unavailable"}</dd>
        <dt>Evidence</dt>
        <dd>
          {row.freshness ?? "unknown"} · {row.sourceObservedAt ?? "undated"}
        </dd>
        <dt>Read at</dt>
        <dd>{row.observedAt}</dd>
        <dt>Balance (source)</dt>
        <dd>
          {measured(row.balance) === undefined
            ? "—"
            : `${String(row.balance)} ${row.currency ?? ""}`.trim()}
        </dd>
        <dt>Burn/day (source)</dt>
        <dd>
          {measured(row.burnPerDay) === undefined
            ? "—"
            : `${String(row.burnPerDay)} ${row.currency ?? ""}/day`}
        </dd>
        <dt>Payer / beneficiary</dt>
        <dd>
          {row.payer ?? "Unknown"} / {row.beneficiary ?? "Unknown"}
        </dd>
        <dt>Reason code</dt>
        <dd>{row.reasonCode ?? "—"}</dd>
        <dt>Detail</dt>
        <dd>{row.detail ?? "—"}</dd>
        {row.nativeRate ? (
          <>
            <dt>Exact rate</dt>
            <dd>
              {row.nativeRate.amount} {row.nativeRate.currency}/
              {row.nativeRate.per}
            </dd>
          </>
        ) : null}
        {row.cumulativeVendorTransfer ? (
          <>
            <dt>Provider transfers · cumulative</dt>
            <dd>
              {row.cumulativeVendorTransfer.amount}{" "}
              {row.cumulativeVendorTransfer.currency}
            </dd>
          </>
        ) : null}
        {row.kind === "wallet" ? (
          <>
            <dt>Custody</dt>
            <dd>Observed holdings; not available DAO cash.</dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}

export function MoneyPlaneTable({
  rows,
  takenAt,
  treasuryPlane,
  costRateEvidence,
}: {
  rows: readonly MoneyPlaneRow[];
  takenAt: string;
  treasuryPlane: string | null;
  costRateEvidence: readonly CostRateEvidence[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sorting, setSorting] = useState<SortingState>([
    { id: "status", desc: false },
    { id: "runway", desc: false },
  ]);
  const data = useMemo(
    () => rows.filter((row) => row.kind !== "wallet"),
    [rows]
  );
  const treasury = rows.find(
    (row) => row.kind === "wallet" && row.plane === treasuryPlane
  );
  const custody = rows.filter(
    (row) => row.kind === "wallet" && row.plane !== treasuryPlane
  );
  const summary = useMemo(
    () => summarizeCostRates(costRateEvidence),
    [costRateEvidence]
  );
  const columns = useMemo(
    () => createMoneyPlaneColumns(costRateEvidence),
    [costRateEvidence]
  );
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.plane,
  });
  return (
    <div className="min-w-0 space-y-4 tabular-nums">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>Financials</h1>
        <div className="flex items-center gap-2">
          <time dateTime={takenAt}>{takenAt.slice(11, 16)} UTC</time>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => startTransition(() => router.refresh())}
          >
            {pending ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>
      <div>
        <span>DAO treasury · </span>
        <strong>
          {treasury ? amount(treasury.balance, treasury.currency) : "—"}
        </strong>
        {treasury ? <EvidenceDetails row={treasury} /> : null}
      </div>
      {custody.length ? (
        <details>
          <summary>Funding accounts</summary>
          <dl className="space-y-2 py-2">
            {custody.map((row) => (
              <div key={row.plane}>
                <dt>{row.label}</dt>
                <dd>
                  {amount(row.balance, row.currency)}
                  <EvidenceDetails row={row} />
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <h2>Costs</h2>
      <DataGrid
        table={table}
        recordCount={data.length}
        tableLayout={{ dense: true, rowBorder: true, headerBackground: true }}
        emptyMessage="No cost sources configured."
      >
        <DataGridContainer className="max-w-full overflow-x-auto">
          <DataGridTable />
        </DataGridContainer>
      </DataGrid>
      <p className="text-muted-foreground text-sm">
        Payment history unavailable
      </p>
      <dl className="space-y-2">
        {summary.cohorts.map((cohort) => (
          <div
            key={JSON.stringify([
              cohort.ownerId,
              cohort.scopeId,
              cohort.instrumentId,
              cohort.rate.currency,
              cohort.rate.per,
              cohort.basis,
            ])}
          >
            <dt>
              {cohort.basis.kind === "contract"
                ? "Known contract rate"
                : "Measured burn"}{" "}
              · {cohort.scopeId}
            </dt>
            <dd>
              <strong>
                {cohort.rate.amount === null
                  ? "—"
                  : rateText(
                      cohort.rate.amount,
                      cohort.rate.currency,
                      cohort.rate.per
                    )}
              </strong>
              {cohort.partial ? " · Partial" : ""}
              {cohort.basis.kind === "contract" ? " · Last known" : ""}
              {cohort.ageUnknown
                ? " · Age unknown"
                : ` · ${cohort.oldestObservedAt}`}
              <details>
                <summary>Rate evidence</summary>
                <p>
                  Oldest source observation:{" "}
                  {cohort.oldestObservedAt ?? "Unknown"}
                </p>
                <p>
                  {cohort.ownerId} · {cohort.instrumentId} ·{" "}
                  {cohort.rate.amount ?? "Unknown"} {cohort.rate.currency}/
                  {cohort.rate.per}
                </p>
                {cohort.basis.kind === "measured" ? (
                  <p>
                    {cohort.basis.start} – {cohort.basis.end}
                  </p>
                ) : null}
              </details>
            </dd>
          </div>
        ))}
      </dl>
      {summary.unattributedCount ? (
        <p>{summary.unattributedCount} rates have unknown attribution.</p>
      ) : null}
    </div>
  );
}
