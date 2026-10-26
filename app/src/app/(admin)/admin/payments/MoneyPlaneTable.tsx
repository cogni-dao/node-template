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
  AdminText,
  Button,
  Card,
  CardContent,
  CardHeader,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from "@/components";

const STATUS = {
  RED: { label: "Low", variant: "destructive-light", rank: 0 },
  YELLOW: { label: "Watch", variant: "warning-light", rank: 1 },
  UNKNOWN: { label: "Not reported", variant: "outline", rank: 2 },
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
  per: string,
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
  instruments: ReadonlyMap<string, string | null>,
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

function readableTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}
function compactTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return `${new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}
function compactWindow(start: string, end: string): string {
  return `${compactTime(start)} – ${compactTime(end)}`;
}
function serviceName(row: MoneyPlaneRow): string {
  if (row.plane === "ai:operator-covered") return "AI";
  if (row.plane === "hosting:operator-covered") return "Hosting";
  return row.label;
}
function statusLabel(row: MoneyPlaneRow): string {
  if (
    row.grade === "UNKNOWN" &&
    (row.reasonCode === "unreadable" || row.reasonCode === "timeout")
  )
    return "Unavailable";
  if (row.grade === "UNKNOWN" && row.freshness === "stale")
    return "Out of date";
  return STATUS[row.grade].label;
}
function sourceAge(row: MoneyPlaneRow): string {
  const time = compactTime(row.sourceObservedAt);
  return time
    ? `${row.freshness === "stale" ? "Stale · " : ""}Observed ${time}`
    : "Source age unknown";
}
function explanation(row: MoneyPlaneRow): string {
  if (
    row.coverage === "operator-covered" &&
    burn(row)?.value === undefined &&
    row.balance === null
  )
    return "The operator funds this service. This node’s cost is not yet reported.";
  if (row.kind === "wallet")
    return row.balance === null
      ? "The configured account balance could not be read."
      : "Observed account holdings; spending authority is separate.";
  if (row.reasonCode === "unreadable" || row.reasonCode === "timeout")
    return "The source could not be read. Refresh to try again.";
  if (row.freshness === "stale")
    return "This is older source evidence. Current funding cannot be confirmed.";
  return row.grade === "UNKNOWN"
    ? "Financial evidence is incomplete for this service."
    : "Financial evidence reported by this source.";
}
function hasSource(row: MoneyPlaneRow): boolean {
  return Boolean(
    (row.source && row.source !== "Operator sponsorship") ||
      row.sourceObservedAt ||
      row.nativeRate ||
      row.cumulativeVendorTransfer ||
      row.kind === "wallet" ||
      row.reasonCode === "unreadable" ||
      row.reasonCode === "timeout",
  );
}
function EvidenceField({ label, value }: { label: string; value: string }) {
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
/** Meaningful financial evidence; backend identifiers and arbitrary details stay private. */
export function MoneyPlaneEvidence({
  row,
  evidence,
}: {
  row: MoneyPlaneRow;
  evidence?: CostRateEvidence | undefined;
}) {
  const observed = readableTime(row.sourceObservedAt);
  return (
    <dl className="grid min-w-0 gap-5">
      {row.kind === "wallet" ? (
        <EvidenceField label="Configured roles" value={row.label} />
      ) : null}
      {measured(row.balance) !== undefined ? (
        <EvidenceField
          label="Exact balance"
          value={`${row.balance} ${row.currency ?? ""}`}
        />
      ) : null}
      {row.nativeRate ? (
        <EvidenceField
          label="Exact source rate"
          value={`${row.nativeRate.amount} ${row.nativeRate.currency}/${row.nativeRate.per}`}
        />
      ) : measured(row.burnPerDay) !== undefined ? (
        <EvidenceField
          label="Source rate"
          value={`${row.burnPerDay} ${row.currency ?? ""}/day`}
        />
      ) : null}
      {row.source ? <EvidenceField label="Source" value={row.source} /> : null}
      {row.kind !== "wallet" && row.payer ? (
        <EvidenceField label="Funded by" value={row.payer} />
      ) : null}
      {row.beneficiary && row.beneficiary !== "This node" ? (
        <EvidenceField label="For" value={row.beneficiary} />
      ) : null}
      {observed ? (
        <EvidenceField
          label={row.kind === "wallet" ? "Balance observed" : "Source observed"}
          value={`${observed}${row.freshness === "stale" ? " · Stale" : ""}`}
        />
      ) : (
        <EvidenceField
          label="Source timing"
          value="Observation time is unavailable."
        />
      )}
      {evidence?.basis.kind === "measured" ? (
        <EvidenceField
          label="Measurement period"
          value={`${readableTime(evidence.basis.start)} – ${readableTime(evidence.basis.end)}`}
        />
      ) : null}
      {row.nativeRate?.per === "block" ? (
        <AdminText variant="muted">
          Per-block contract rate; a daily cost estimate is not available.
        </AdminText>
      ) : null}
      {row.cumulativeVendorTransfer ? (
        <div className="space-y-1">
          <EvidenceField
            label="Provider transfers · cumulative"
            value={`${row.cumulativeVendorTransfer.amount} ${row.cumulativeVendorTransfer.currency}`}
          />
          <AdminText variant="muted">
            Source total, without a complete payment history or common reporting
            period.
          </AdminText>
        </div>
      ) : null}
    </dl>
  );
}
function SourceDialog({
  row,
  evidence,
}: {
  row: MoneyPlaneRow;
  evidence?: CostRateEvidence | undefined;
}) {
  if (!hasSource(row)) return null;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 shrink-0"
          aria-label={`Source for ${serviceName(row)}`}
        >
          Source
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-dvh min-w-0 overflow-y-auto break-words [&>button]:flex [&>button]:min-h-11 [&>button]:min-w-11 [&>button]:items-center [&>button]:justify-center">
        <DialogHeader className="min-w-0 pr-11">
          <DialogTitle>{serviceName(row)} source</DialogTitle>
          <DialogDescription>{explanation(row)}</DialogDescription>
        </DialogHeader>
        <MoneyPlaneEvidence row={row} {...(evidence ? { evidence } : {})} />
      </DialogContent>
    </Dialog>
  );
}
function RateValue({
  row,
  evidence,
}: {
  row: MoneyPlaneRow;
  evidence?: CostRateEvidence | undefined;
}) {
  const rate = burn(row);
  if (rate?.value === undefined)
    return <AdminText variant="muted">Not reported</AdminText>;
  return (
    <div className="min-w-0 space-y-1">
      <AdminText variant="numeric">
        {rateText(rate.value, rate.currency, rate.per)}
      </AdminText>
      <AdminText variant="detail">
        {evidence?.basis.kind === "contract"
          ? "Contract rate"
          : evidence?.basis.kind === "measured"
            ? "Measured burn"
            : "Basis unknown"}
        {evidence?.partial ? " · Partial" : ""}
      </AdminText>
      <AdminText variant="detail">{sourceAge(row)}</AdminText>
      {evidence?.basis.kind === "measured" ? (
        <AdminText variant="detail">
          {compactWindow(evidence.basis.start, evidence.basis.end)}
        </AdminText>
      ) : null}
    </div>
  );
}
function ServiceIdentity({
  row,
  evidence,
}: {
  row: MoneyPlaneRow;
  evidence?: CostRateEvidence | undefined;
}) {
  return (
    <div className="min-w-0 @3xl:flex @3xl:items-center @3xl:justify-between @3xl:gap-2">
      <div className="min-w-0 space-y-1">
        <AdminText variant="label">{serviceName(row)}</AdminText>
        {row.beneficiary && row.beneficiary !== "This node" ? (
          <AdminText variant="detail">{row.beneficiary}</AdminText>
        ) : null}
        {row.payer !== "Operator" ? (
          <AdminText variant="detail">
            Funded by {row.payer ?? "unknown payer"}
          </AdminText>
        ) : null}
      </div>
      <SourceDialog row={row} {...(evidence ? { evidence } : {})} />
    </div>
  );
}
const column = createColumnHelper<MoneyPlaneRow>();
export function createMoneyPlaneColumns(
  rateEvidence: readonly CostRateEvidence[] = [],
) {
  const instruments = new Map(
    rateEvidence.map((item) => [item.sourceId, item.instrumentId]),
  );
  const evidence = new Map(rateEvidence.map((item) => [item.sourceId, item]));
  return [
    column.accessor("label", {
      id: "service",
      header: "Service",
      cell: ({ row }) => (
        <ServiceIdentity
          row={row.original}
          {...(evidence.get(row.original.plane)
            ? { evidence: evidence.get(row.original.plane) }
            : {})}
        />
      ),
    }),
    column.accessor((row) => measured(row.balance), {
      id: "balance",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Balance / credit" />
      ),
      sortUndefined: "last",
      sortingFn: (a, b, id) => nativeSort(a, b, id, instruments),
      cell: ({ row }) => (
        <AdminText variant="numeric">
          {amount(row.original.balance, row.original.currency)}
        </AdminText>
      ),
    }),
    column.accessor((row) => burn(row)?.value, {
      id: "rate",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Rate" />
      ),
      sortUndefined: "last",
      sortingFn: (a, b, id) => nativeSort(a, b, id, instruments),
      cell: ({ row }) => (
        <RateValue
          row={row.original}
          {...(evidence.get(row.original.plane)
            ? { evidence: evidence.get(row.original.plane) }
            : {})}
        />
      ),
    }),
    column.accessor((row) => measured(row.runwayDays), {
      id: "runway",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Runway" />
      ),
      sortUndefined: "last",
      cell: ({ getValue }) => (
        <AdminText variant="numeric">
          {getValue() === undefined
            ? "Not reported"
            : `${numberText(getValue() ?? 0)} days`}
        </AdminText>
      ),
    }),
    column.accessor((row) => STATUS[row.grade].rank, {
      id: "status",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => (
        <StatusBadge variant={STATUS[row.original.grade].variant}>
          {statusLabel(row.original)}
        </StatusBadge>
      ),
    }),
  ];
}
export const moneyPlaneColumns = createMoneyPlaneColumns();
export interface MoneyPlaneTableProps {
  rows: readonly MoneyPlaneRow[];
  takenAt: string;
  treasuryPlane: string | null;
  costRateEvidence: readonly CostRateEvidence[];
  configuredWalletPlanes: readonly string[];
}
export function MoneyPlaneTable({
  rows,
  takenAt,
  treasuryPlane,
  costRateEvidence,
  configuredWalletPlanes,
}: MoneyPlaneTableProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [refreshFrom, setRefreshFrom] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const data = useMemo(
    () => rows.filter((row) => row.kind !== "wallet"),
    [rows],
  );
  const visibility = {
    balance: data.some((r) => measured(r.balance) !== undefined),
    rate: data.some((r) => burn(r)?.value !== undefined),
    runway: data.some((r) => measured(r.runwayDays) !== undefined),
  };
  const [sorting, setSorting] = useState<SortingState>([
    { id: "status", desc: false },
    { id: "runway", desc: false },
  ]);
  const activeSorting = sorting.filter(
    (sort) =>
      !(sort.id in visibility) ||
      visibility[sort.id as keyof typeof visibility],
  );
  const effectiveSorting = activeSorting.length
    ? activeSorting
    : [{ id: "status", desc: false }];
  const treasury = rows.find(
    (r) => r.kind === "wallet" && r.plane === treasuryPlane,
  );
  const custody = rows.filter(
    (r) =>
      r.kind === "wallet" &&
      r.plane !== treasuryPlane &&
      configuredWalletPlanes.includes(r.plane),
  );
  const summary = useMemo(
    () => summarizeCostRates(costRateEvidence),
    [costRateEvidence],
  );
  const columns = useMemo(
    () => createMoneyPlaneColumns(costRateEvidence),
    [costRateEvidence],
  );
  const table = useReactTable({
    data,
    columns,
    state: { sorting: effectiveSorting, columnVisibility: visibility },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.plane,
  });
  const commonOperator = data.some((r) => r.payer === "Operator");
  const sortKeys = [
    { id: "status", label: "Status" },
    ...Object.entries(visibility)
      .filter(([, present]) => present)
      .map(([id]) => ({
        id,
        label: id === "balance" ? "Balance" : id === "rate" ? "Rate" : "Runway",
      })),
  ];
  const sorted = effectiveSorting[0] ?? { id: "status", desc: false };
  const sortLabel =
    sortKeys.find((key) => key.id === sorted.id)?.label ?? "Status";
  return (
    <div
      className="@container mx-auto min-w-0 max-w-6xl space-y-6"
      data-financials-report
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <AdminText as="h1" variant="title">
            Financials
          </AdminText>
          <AdminText variant="muted">
            This DAO · Refreshed {compactTime(takenAt)}
          </AdminText>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={() => {
            if (!navigator.onLine) {
              setRefreshError(
                "You’re offline. Showing the last report; reconnect to refresh.",
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
          className={refreshError ? "w-full" : "sr-only"}
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
      <div className="grid gap-4 @lg:grid-cols-2">
        <Card className="min-w-0 gap-3 py-0">
          <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 pt-4 pb-0">
            <AdminText as="h2" variant="label">
              DAO treasury
            </AdminText>
            {treasury ? <SourceDialog row={treasury} /> : null}
          </CardHeader>
          <CardContent className="space-y-2 px-4 pb-4">
            <AdminText variant="value">
              {treasury
                ? measured(treasury.balance) === undefined
                  ? "Balance unavailable"
                  : amount(treasury.balance, treasury.currency)
                : "Treasury not identified"}
            </AdminText>
            {treasury ? (
              <>
                <AdminText variant="detail">{sourceAge(treasury)}</AdminText>
                <AdminText variant="detail">{treasury.label}</AdminText>
              </>
            ) : null}
          </CardContent>
        </Card>
        <Card className="min-w-0 gap-3 py-0">
          <CardHeader className="px-4 pt-4 pb-0">
            <AdminText as="h2" variant="label">
              Operating costs
            </AdminText>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4">
            {summary.cohorts.length ? (
              summary.cohorts.map((cohort, index) => (
                <div
                  key={`${cohort.instrumentId}:${index}`}
                  className="min-w-0 space-y-1"
                >
                  <AdminText variant="value">
                    {cohort.rate.amount === null
                      ? "Not reported"
                      : rateText(
                          cohort.rate.amount,
                          cohort.rate.currency,
                          cohort.rate.per,
                        )}
                  </AdminText>
                  <AdminText variant="muted">
                    {cohort.basis.kind === "contract"
                      ? "Known contract rate"
                      : "Measured burn"}{" "}
                    ·{" "}
                    {cohort.scopeId === "operator-fleet"
                      ? "Operator fleet"
                      : "Reported scope"}
                  </AdminText>
                  <AdminText variant="detail">
                    Funded by{" "}
                    {cohort.ownerId === "operator"
                      ? "operator"
                      : "reported payer"}
                    {cohort.partial ? " · Partial" : ""}
                    {cohort.basis.kind === "contract" ? " · Last known" : ""} ·{" "}
                    {cohort.ageUnknown
                      ? "Age unknown"
                      : compactTime(cohort.oldestObservedAt)}
                  </AdminText>
                  {cohort.basis.kind === "measured" ? (
                    <AdminText variant="detail">
                      {compactWindow(cohort.basis.start, cohort.basis.end)}
                    </AdminText>
                  ) : null}
                </div>
              ))
            ) : (
              <>
                <AdminText variant="value">
                  {commonOperator ? "Operator-funded" : "Costs not reported"}
                </AdminText>
                <AdminText variant="muted">
                  This node’s cost is not yet reported.
                </AdminText>
              </>
            )}
            {summary.unattributedCount ? (
              <AdminText variant="muted">
                {summary.unattributedCount} rates have unknown attribution.
              </AdminText>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <section className="min-w-0 space-y-3" aria-label="Services">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <AdminText as="h2" variant="section">
              Services
            </AdminText>
            {commonOperator ? (
              <AdminText variant="muted">Funded by operator</AdminText>
            ) : null}
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <AdminText as="span" variant="muted">
              Sort
            </AdminText>
            <Select
              value={sorted.id}
              onValueChange={(id) => setSorting([{ id, desc: sorted.desc }])}
            >
              <SelectTrigger
                aria-label="Sort services by"
                className="min-h-11 w-32"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sortKeys.map((key) => (
                  <SelectItem key={key.id} value={key.id}>
                    {key.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              className="min-h-11"
              aria-label={`Sort ${sortLabel} ${sorted.desc ? "ascending" : "descending"}`}
              onClick={() =>
                setSorting([{ id: sorted.id, desc: !sorted.desc }])
              }
            >
              {sorted.desc ? "Descending" : "Ascending"}
            </Button>
          </div>
          <span className="sr-only" role="status" aria-live="polite">
            Sorted by {sortLabel}, {sorted.desc ? "descending" : "ascending"}
          </span>
        </div>
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
            emptyMessage="No services reported."
          >
            <DataGridContainer>
              <DataGridTable />
            </DataGridContainer>
          </DataGrid>
        </div>
        <div className="space-y-3 @3xl:hidden">
          {table.getRowModel().rows.map(({ original: row }) => {
            const evidence = costRateEvidence.find(
              (e) => e.sourceId === row.plane,
            );
            return (
              <Card key={row.plane} className="min-w-0 py-0">
                <CardContent className="space-y-3 p-4">
                  <div className="min-w-0 space-y-2">
                    <ServiceIdentity
                      row={row}
                      {...(evidence ? { evidence } : {})}
                    />
                    <StatusBadge variant={STATUS[row.grade].variant}>
                      {statusLabel(row)}
                    </StatusBadge>
                  </div>
                  {visibility.balance ||
                  visibility.rate ||
                  visibility.runway ? (
                    <dl className="grid min-w-0 gap-4 @sm:grid-cols-2">
                      {visibility.balance ? (
                        <EvidenceField
                          label="Balance / credit"
                          value={amount(row.balance, row.currency)}
                        />
                      ) : null}
                      {visibility.rate ? (
                        <div className="min-w-0">
                          <AdminText as="dt" variant="muted">
                            Rate
                          </AdminText>
                          <dd>
                            <RateValue
                              row={row}
                              {...(evidence ? { evidence } : {})}
                            />
                          </dd>
                        </div>
                      ) : null}
                      {visibility.runway ? (
                        <EvidenceField
                          label="Runway"
                          value={
                            row.runwayDays === null
                              ? "Not reported"
                              : `${numberText(row.runwayDays)} days`
                          }
                        />
                      ) : null}
                    </dl>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
        {!data.length ? (
          <AdminText variant="muted">No services reported.</AdminText>
        ) : null}
        {!visibility.balance || !visibility.rate || !visibility.runway ? (
          <AdminText variant="detail">
            Not yet reported:{" "}
            {[
              !visibility.balance ? "service balances" : null,
              !visibility.rate ? "node cost rates" : null,
              !visibility.runway ? "runway" : null,
            ]
              .filter(Boolean)
              .join(", ")}
            .
          </AdminText>
        ) : null}
      </section>
      {custody.length ? (
        <section className="space-y-3" aria-label="Other accounts">
          <div>
            <AdminText as="h2" variant="section">
              Other accounts
            </AdminText>
            <AdminText variant="muted">
              Custody accounts · DAO ownership not established
            </AdminText>
          </div>
          <Card className="py-0">
            <CardContent className="space-y-3 p-4">
              {custody.map((row) => (
                <div
                  key={row.plane}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <AdminText variant="label">{row.label}</AdminText>
                    <AdminText variant="detail">{sourceAge(row)}</AdminText>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <AdminText variant="numeric">
                      {row.balance === null
                        ? "Balance unavailable"
                        : amount(row.balance, row.currency)}
                    </AdminText>
                    <SourceDialog row={row} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      ) : null}
      <AdminText variant="muted">
        Payment history is not available in this report.
      </AdminText>
    </div>
  );
}
