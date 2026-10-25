// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `admin/payments/MoneyPlaneTable`
 * Purpose: Compact node-owned Payments grid with native summaries and sortable evidence.
 * Scope: Client presentation of an authorized server report; no provider reads or payments.
 * Invariants: Native units/custody remain separate; missing last; no inferred payment history.
 * Side-effects: local sort state, route refresh
 * Links: packages/money-plane/src/summarize.ts
 * @public
 */
"use client";

import {
  type Grade,
  type MoneyPlaneRow,
  type NativeAmount,
  summarizeRows,
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
function totals(values: readonly NativeAmount[]): string {
  return (
    values
      .map((value) => `${numberText(value.amount)} ${value.currency}`)
      .join(" · ") || "—"
  );
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
  id: string
): number {
  const group = (row: MoneyPlaneRow) =>
    id === "burn"
      ? `${burn(row)?.currency ?? ""}/${burn(row)?.per ?? ""}`
      : id === "paid"
        ? (row.cumulativeVendorTransfer?.currency ?? "")
        : (row.currency ?? "");
  return (
    group(a.original).localeCompare(group(b.original)) ||
    a.getValue<number>(id) - b.getValue<number>(id)
  );
}

const column = createColumnHelper<MoneyPlaneRow>();
export const moneyPlaneColumns = [
  column.accessor("label", {
    id: "service",
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Service" />
    ),
    cell: ({ row }) => (
      <div className="flex flex-wrap items-center gap-2">
        <span>{row.original.label}</span>
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
      <DataGridColumnHeader column={column} title="Balance" />
    ),
    sortUndefined: "last",
    sortingFn: nativeSort,
    cell: ({ row }) => amount(row.original.balance, row.original.currency),
  }),
  column.accessor((row) => burn(row)?.value, {
    id: "burn",
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Burn" />
    ),
    sortUndefined: "last",
    sortingFn: nativeSort,
    cell: ({ row }) => {
      const rate = burn(row.original);
      return rate?.value === undefined
        ? "—"
        : `${numberText(rate.value)} ${rate.currency}/${rate.per}`;
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
  column.accessor(
    (row) =>
      row.cumulativeVendorTransfer
        ? measured(Number(row.cumulativeVendorTransfer.amount))
        : undefined,
    {
      id: "paid",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Paid (cumulative)" />
      ),
      sortUndefined: "last",
      sortingFn: nativeSort,
      cell: ({ row }) =>
        row.original.cumulativeVendorTransfer
          ? totals([row.original.cumulativeVendorTransfer])
          : "—",
    }
  ),
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
    cell: ({ row }) => (
      <details>
        <summary aria-label={`Details for ${row.original.label}`}>
          Details
        </summary>
        <dl className="grid gap-1 py-2">
          <dt>Source</dt>
          <dd>{row.original.source ?? "Unavailable"}</dd>
          <dt>Evidence</dt>
          <dd>
            {row.original.freshness ?? "unknown"} ·{" "}
            {row.original.sourceObservedAt ?? "undated"}
          </dd>
          <dt>Read at</dt>
          <dd>{row.original.observedAt}</dd>
          <dt>Balance (source)</dt>
          <dd>
            {measured(row.original.balance) === undefined
              ? "—"
              : `${String(row.original.balance)} ${row.original.currency ?? ""}`.trim()}
          </dd>
          <dt>Burn/day (source)</dt>
          <dd>
            {measured(row.original.burnPerDay) === undefined
              ? "—"
              : `${String(row.original.burnPerDay)} ${row.original.currency ?? ""}/day`}
          </dd>
          <dt>Payer / beneficiary</dt>
          <dd>
            {row.original.payer ?? "Unknown"} /{" "}
            {row.original.beneficiary ?? "Unknown"}
          </dd>
          <dt>Reason code</dt>
          <dd>{row.original.reasonCode ?? "—"}</dd>
          <dt>Detail</dt>
          <dd>{row.original.detail ?? "—"}</dd>
          {row.original.nativeRate ? (
            <>
              <dt>Exact rate</dt>
              <dd>
                {row.original.nativeRate.amount}{" "}
                {row.original.nativeRate.currency}/{row.original.nativeRate.per}
              </dd>
            </>
          ) : null}
          {row.original.cumulativeVendorTransfer ? (
            <>
              <dt>Cumulative vendor transfer</dt>
              <dd>
                {row.original.cumulativeVendorTransfer.amount}{" "}
                {row.original.cumulativeVendorTransfer.currency}
              </dd>
            </>
          ) : null}
          {row.original.kind === "wallet" ? (
            <>
              <dt>Custody</dt>
              <dd>Observed holdings; not available DAO cash.</dd>
            </>
          ) : null}
        </dl>
      </details>
    ),
  }),
];

export function MoneyPlaneTable({
  rows,
  takenAt,
}: {
  rows: readonly MoneyPlaneRow[];
  takenAt: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sorting, setSorting] = useState<SortingState>([
    { id: "status", desc: false },
    { id: "runway", desc: false },
  ]);
  const data = useMemo(() => [...rows], [rows]);
  const summary = useMemo(() => summarizeRows(rows), [rows]);
  const table = useReactTable({
    data,
    columns: moneyPlaneColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.plane,
  });
  const burnTotal =
    summary.burn.rates
      .map((rate) => `${numberText(rate.amount)} ${rate.currency}/${rate.per}`)
      .join(" · ") || "—";
  return (
    <div className="min-w-0 space-y-4 tabular-nums">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>Payments</h1>
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
      <div className="flex flex-wrap gap-6">
        <div>
          <span>Wallets · </span>
          <strong>{totals(summary.wallets.amounts)}</strong>
          {summary.wallets.partial ? (
            <StatusBadge variant="outline">Partial</StatusBadge>
          ) : null}
        </div>
        <div>
          <span>Prepaid · </span>
          <strong>{totals(summary.prepaid.amounts)}</strong>
          {summary.prepaid.partial ? (
            <StatusBadge variant="outline">Partial</StatusBadge>
          ) : null}
        </div>
      </div>
      <DataGrid
        table={table}
        recordCount={data.length}
        tableLayout={{ dense: true, rowBorder: true, headerBackground: true }}
        emptyMessage="No sources configured."
      >
        <DataGridContainer className="max-w-full overflow-x-auto">
          <DataGridTable
            footerContent={
              <tr>
                <th scope="row">Known totals</th>
                <td>
                  Wallets: {totals(summary.wallets.amounts)}
                  <br />
                  Prepaid: {totals(summary.prepaid.amounts)}
                </td>
                <td>
                  {burnTotal}
                  {summary.burn.partial ? " · Partial" : ""}
                </td>
                <td>—</td>
                <td>
                  {totals(summary.paid.amounts)}
                  {summary.paid.partial ? " · Partial" : ""}
                </td>
                <td />
                <td />
              </tr>
            }
          />
        </DataGridContainer>
      </DataGrid>
    </div>
  );
}
