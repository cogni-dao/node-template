// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `admin/payments/MoneyPlaneTable`
 * Purpose: Financials — one table of this node's money planes: balance, burn/day, runway and source, in risk order.
 * Scope: Client presentation of an authorized server report; no provider reads or payments.
 * Invariants: Unknown renders as a muted dash with a one-line human reason behind Source; native units only, no FX or
 *   pooled totals; no per-row status pills; the same sorted rows stack below 48rem of container width.
 * Side-effects: local sort state, route refresh
 * Links: money-plane.server.ts, https://cognidao.org/knowledge/finances-expert
 * @public
 */
"use client";

import type { Grade, MoneyPlaneRow } from "@cogni/money-plane";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  type Row,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import {
  AdminText,
  Button,
  DataGrid,
  DataGridColumnHeader,
  DataGridContainer,
  DataGridTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components";

/** Default row order: RED, YELLOW; then rows with a known number (GREEN, INFO, UNKNOWN); placeholders last. */
const RISK: Record<Grade, number> = {
  RED: 0,
  YELLOW: 1,
  GREEN: 2,
  INFO: 3,
  UNKNOWN: 4,
};
const PLACEHOLDER_RANK = 5;
const RUNWAY_TONE: Partial<Record<Grade, string>> = {
  RED: "text-danger",
  YELLOW: "text-warning",
  GREEN: "text-success",
};
const DOLLAR_CURRENCIES = new Set(["USD", "USDC"]);
const DASH = "—";

function measured(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function money(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
/** "10.77 USDC" or a dash. */
export function balanceText(row: MoneyPlaneRow): string {
  const value = measured(row.balance);
  return value === undefined
    ? DASH
    : `${money(value)} ${row.currency ?? ""}`.trim();
}
/** "$0.42 / day" or a dash. */
export function burnText(row: MoneyPlaneRow): string {
  const value = measured(row.burnPerDay);
  if (value === undefined) return DASH;
  return DOLLAR_CURRENCIES.has(row.currency ?? "")
    ? `$${money(value)} / day`
    : `${money(value)} ${row.currency ?? ""} / day`.trim();
}
/** "12 d" for a graded runway; a dash for unknown or holdings. */
export function runwayText(row: MoneyPlaneRow): string {
  const value = measured(row.runwayDays);
  if (value === undefined || row.grade === "UNKNOWN" || row.grade === "INFO")
    return DASH;
  return `${Math.round(value)} d`;
}
/** One human line explaining a missing number; null when nothing is missing. */
export function unavailableReason(row: MoneyPlaneRow): string | null {
  if (row.coverage === "operator-covered" && measured(row.balance) === undefined)
    return "cost reported by operator, not yet shared";
  if (row.grade !== "UNKNOWN") return null;
  switch (row.reasonCode) {
    case "unconfigured":
      return row.kind === "wallet"
        ? "no address configured"
        : "no key configured";
    case "unreadable":
      return row.kind === "wallet" ? "RPC unavailable" : "source unavailable";
    case "timeout":
      return "source timed out";
    case "burn_unmeasured":
      return "burn not measured";
    case "stale":
      return "source out of date";
    case "lease_starved":
      return "lease out of escrow";
    case "no_leases":
      return "no active leases";
    case "escrow_advisory":
      return "escrow below advisory level";
    default:
      return "not measured";
  }
}
/** A placeholder carries no number at all; a known number (including zero) outranks it. */
function hasNumber(row: MoneyPlaneRow): boolean {
  return row.balance !== null || row.burnPerDay !== null;
}
export function riskRank(row: MoneyPlaneRow): number {
  if (row.grade === "RED" || row.grade === "YELLOW") return RISK[row.grade];
  return hasNumber(row) ? RISK[row.grade] : PLACEHOLDER_RANK;
}
export function riskCompare(a: MoneyPlaneRow, b: MoneyPlaneRow): number {
  return riskRank(a) - riskRank(b) || a.label.localeCompare(b.label);
}
/** Which numeric columns carry any value; a column of nothing but dashes is replaced by one note. */
export function reportedColumns(rows: readonly MoneyPlaneRow[]): {
  burn: boolean;
  runway: boolean;
} {
  return {
    burn: rows.some((row) => row.burnPerDay !== null),
    runway: rows.some((row) => row.runwayDays !== null),
  };
}
export function unreportedNote(columns: {
  burn: boolean;
  runway: boolean;
}): string | null {
  if (!columns.burn && !columns.runway)
    return "Burn and runway are not yet reported for this node.";
  if (!columns.runway) return "Runway is not yet reported for this node.";
  if (!columns.burn) return "Burn is not yet reported for this node.";
  return null;
}

const subscribeNever = () => () => {};
/** Local zone after hydration; UTC on the server so markup matches. */
function useTimeZone(): string {
  return useSyncExternalStore(
    subscribeNever,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "UTC"
  );
}
function readableTime(
  value: string | null | undefined,
  timeZone: string
): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}

function numericSort(a: Row<MoneyPlaneRow>, b: Row<MoneyPlaneRow>, id: string) {
  return a.getValue<number>(id) - b.getValue<number>(id);
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <AdminText as="dt" variant="muted">
        {label}
      </AdminText>
      <AdminText as="dd" variant="numeric">
        {value}
      </AdminText>
    </div>
  );
}

/** Dialog body: readable source, exact native amounts, observed time, and the reason when unavailable. */
export function MoneyPlaneEvidence({ row }: { row: MoneyPlaneRow }) {
  const timeZone = useTimeZone();
  const observed = readableTime(row.sourceObservedAt, timeZone);
  const reason = unavailableReason(row);
  return (
    <dl className="grid min-w-0 gap-4">
      <Field label="Source" value={row.source ?? "Not read"} />
      {measured(row.balance) !== undefined ? (
        <Field
          label="Exact balance"
          value={`${row.balance} ${row.currency ?? ""}`.trim()}
        />
      ) : null}
      {measured(row.burnPerDay) !== undefined ? (
        <Field
          label="Exact burn"
          value={`${row.burnPerDay} ${row.currency ?? ""} / day`.trim()}
        />
      ) : null}
      {row.coverage === "operator-covered" ? (
        <Field label="Funded by" value={row.payer ?? "Operator"} />
      ) : null}
      <Field label="Observed" value={observed ?? "Not observed"} />
      {reason ? <Field label="Unavailable" value={reason} /> : null}
    </dl>
  );
}

function SourceDialog({ row }: { row: MoneyPlaneRow }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="link"
          size="sm"
          className="h-auto min-h-11 px-0 text-sm"
          aria-label={`Source for ${row.label}`}
        >
          Source
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-dvh min-w-0 overflow-y-auto break-words">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle>{row.label}</DialogTitle>
          <DialogDescription>
            Exact native amounts as read; nothing is converted or pooled.
          </DialogDescription>
        </DialogHeader>
        <MoneyPlaneEvidence row={row} />
      </DialogContent>
    </Dialog>
  );
}

function LineCell({ row }: { row: MoneyPlaneRow }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <AdminText variant="label">{row.label}</AdminText>
      {row.coverage === "operator-covered" ? (
        <AdminText variant="detail">Funded by operator</AdminText>
      ) : null}
    </div>
  );
}
function RunwayCell({ row }: { row: MoneyPlaneRow }) {
  const text = runwayText(row);
  return (
    <AdminText
      variant="numeric"
      className={text === DASH ? "text-muted-foreground" : RUNWAY_TONE[row.grade]}
    >
      {text}
    </AdminText>
  );
}
function Muted({ text }: { text: string }) {
  return (
    <AdminText
      variant="numeric"
      className={text === DASH ? "text-muted-foreground" : undefined}
    >
      {text}
    </AdminText>
  );
}

const column = createColumnHelper<MoneyPlaneRow>();
export function createMoneyPlaneColumns() {
  return [
    column.accessor("label", {
      id: "line",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Line" />
      ),
      sortingFn: (a, b) => riskCompare(a.original, b.original),
      cell: ({ row }) => <LineCell row={row.original} />,
    }),
    column.accessor((row) => measured(row.balance), {
      id: "balance",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Balance" />
      ),
      sortUndefined: "last",
      sortingFn: numericSort,
      cell: ({ row }) => <Muted text={balanceText(row.original)} />,
    }),
    column.accessor((row) => measured(row.burnPerDay), {
      id: "burn",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Burn/day" />
      ),
      sortUndefined: "last",
      sortingFn: numericSort,
      cell: ({ row }) => <Muted text={burnText(row.original)} />,
    }),
    column.accessor(
      (row) =>
        row.grade === "UNKNOWN" || row.grade === "INFO"
          ? undefined
          : measured(row.runwayDays),
      {
        id: "runway",
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Runway" />
        ),
        sortUndefined: "last",
        sortingFn: numericSort,
        cell: ({ row }) => <RunwayCell row={row.original} />,
      }
    ),
    column.display({
      id: "source",
      header: "Source",
      cell: ({ row }) => <SourceDialog row={row.original} />,
    }),
  ];
}
export const moneyPlaneColumns = createMoneyPlaneColumns();

export interface MoneyPlaneTableProps {
  rows: readonly MoneyPlaneRow[];
  takenAt: string;
  treasuryPlane: string | null;
}

export function MoneyPlaneTable({
  rows,
  takenAt,
  treasuryPlane,
}: MoneyPlaneTableProps) {
  const router = useRouter();
  const timeZone = useTimeZone();
  const [pending, startTransition] = useTransition();
  const [refreshFrom, setRefreshFrom] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([
    { id: "line", desc: false },
  ]);
  const data = useMemo(() => [...rows], [rows]);
  const reported = reportedColumns(rows);
  const note = unreportedNote(reported);
  const table = useReactTable({
    data,
    columns: moneyPlaneColumns,
    state: {
      sorting,
      columnVisibility: { burn: reported.burn, runway: reported.runway },
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.plane,
  });
  const treasury = rows.find((row) => row.plane === treasuryPlane);
  const treasuryBalance = treasury ? measured(treasury.balance) : undefined;
  const summary =
    treasury && treasuryBalance !== undefined
      ? `Treasury ${money(treasuryBalance)} ${treasury.currency ?? "USDC"}`
      : `Treasury balance unavailable · ${
          treasury
            ? (unavailableReason(treasury) ?? "not read")
            : "no treasury configured"
        }`;
  const refreshed = readableTime(takenAt, timeZone) ?? "time unknown";

  return (
    <div className="@container min-w-0 space-y-5" data-financials-report>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <AdminText as="h1" variant="title">
            Financials
          </AdminText>
          <AdminText variant="muted">Report refreshed {refreshed}</AdminText>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={() => {
            if (!navigator.onLine) {
              setRefreshError(
                "You’re offline. Showing the last report; reconnect to refresh."
              );
              return;
            }
            setRefreshError(null);
            setRefreshFrom(takenAt);
            startTransition(() => router.refresh());
          }}
        >
          {pending ? "Refreshing…" : "Refresh"}
        </Button>
        <span
          className={refreshError ? "w-full text-sm" : "sr-only"}
          role="status"
          aria-live="polite"
        >
          {refreshError ??
            (pending
              ? "Refreshing financial report"
              : refreshFrom !== null
                ? takenAt !== refreshFrom
                  ? "Financial report updated"
                  : "Refresh finished; report time is unchanged"
                : "")}
        </span>
      </div>
      <AdminText variant="section" className="tabular-nums">
        {summary}
      </AdminText>
      <div className="hidden min-w-0 @3xl:block">
        <DataGrid
          table={table}
          recordCount={data.length}
          tableLayout={{
            width: "auto",
            dense: false,
            rowBorder: true,
            headerBackground: true,
          }}
          emptyMessage="No money planes configured."
        >
          <DataGridContainer>
            <DataGridTable />
          </DataGridContainer>
        </DataGrid>
      </div>
      <ul className="m-0 list-none space-y-3 p-0 @3xl:hidden" aria-label="Lines">
        {table.getRowModel().rows.map(({ original: row }) => (
          <li
            key={row.plane}
            className="min-w-0 space-y-3 rounded-lg border border-border p-4"
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <LineCell row={row} />
              <SourceDialog row={row} />
            </div>
            <dl className="flex min-w-0 flex-wrap gap-x-8 gap-y-3">
              <Field label="Balance" value={<Muted text={balanceText(row)} />} />
              {reported.burn ? (
                <Field label="Burn/day" value={<Muted text={burnText(row)} />} />
              ) : null}
              {reported.runway ? (
                <Field label="Runway" value={<RunwayCell row={row} />} />
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
      {note ? <AdminText variant="muted">{note}</AdminText> : null}
      <AdminText variant="muted">
        Payment history is not included in this report.
      </AdminText>
    </div>
  );
}
