// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/MoneyPlaneTable`
 * Purpose: One table, one row per money plane: balance, native burn/rate, runway, grade, funding coverage and evidence.
 * Scope: Read-only server component rendering shared finance rows. Does not fetch or move funds.
 * Invariants: ONE_ROW_MODEL — renders MoneyPlaneRow evidence without payment controls.
 *   UNKNOWN shows its reason, never a GREEN badge. Product UI stays local to this node (not node-ui-kit).
 * Side-effects: none
 * Links: packages/money-plane/src/types.ts
 * @public
 */

import type { Grade, MoneyPlaneRow } from "@cogni/money-plane";
import { Badge } from "@cogni/node-ui-kit/reui/badge";
import type { ReactElement } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";

const GRADE_VARIANT = {
  GREEN: "success-light",
  YELLOW: "warning-light",
  RED: "destructive-light",
  UNKNOWN: "outline",
  INFO: "info-light",
} as const satisfies Record<Grade, string>;

function fmtAmount(n: number | null, currency: string | null): string {
  if (n === null) return "—";
  const digits = Math.abs(n) >= 100 ? 0 : 2;
  const value = n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency ? `${value} ${currency}` : value;
}

function fmtRunway(row: MoneyPlaneRow): string {
  if (row.runwayDays !== null) return `${row.runwayDays.toFixed(1)} d`;
  if (row.kind === "wallet") return "n/a";
  return "—";
}

function fmtTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function MoneyPlaneTable({
  rows,
}: {
  rows: readonly MoneyPlaneRow[];
}): ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Account / cost</TableHead>
          <TableHead>Who pays / benefits</TableHead>
          <TableHead className="text-right">Balance</TableHead>
          <TableHead className="text-right">Burn / native rate</TableHead>
          <TableHead className="text-right">Runway</TableHead>
          <TableHead>Grade</TableHead>
          <TableHead>Evidence</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.plane}
            data-plane={row.plane}
            data-grade={row.grade}
          >
            <TableCell>
              <div className="font-medium">{row.label}</div>
              <div className="text-muted-foreground font-mono text-xs">
                {row.plane}
              </div>
            </TableCell>
            <TableCell>
              <div>{row.payer ?? "Unknown payer"}</div>
              <div className="text-muted-foreground text-xs">
                {row.coverage === "operator-covered"
                  ? "Operator covered"
                  : row.coverage === "direct"
                    ? "Direct"
                    : "Coverage unknown"}
                {row.beneficiary ? ` · ${row.beneficiary}` : ""}
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtAmount(row.balance, row.currency)}
              {row.kind === "wallet" && row.detail ? (
                <div className="text-muted-foreground text-xs">
                  {row.detail}
                </div>
              ) : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.nativeRate
                ? `${row.nativeRate.amount} ${row.nativeRate.currency}/${row.nativeRate.per}`
                : row.kind === "wallet"
                  ? "n/a"
                  : row.burnPerDay === null
                    ? "Unknown"
                    : `${fmtAmount(row.burnPerDay, row.currency)}/day`}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtRunway(row)}
            </TableCell>
            <TableCell>
              <Badge variant={GRADE_VARIANT[row.grade]}>{row.grade}</Badge>
              {row.reasonCode ? (
                <div className="text-muted-foreground text-xs">
                  {row.reasonCode.replaceAll("_", " ")}
                  {row.kind !== "wallet" && row.detail
                    ? ` · ${row.detail}`
                    : null}
                </div>
              ) : row.kind !== "wallet" && row.detail ? (
                <div className="text-muted-foreground text-xs">
                  {row.detail}
                </div>
              ) : null}
            </TableCell>
            <TableCell className="text-muted-foreground font-mono text-xs">
              <div>{row.source ?? "Source unavailable"}</div>
              <div>
                {row.freshness ?? "unknown"} ·{" "}
                {row.sourceObservedAt
                  ? fmtTime(row.sourceObservedAt)
                  : "source age unknown"}
              </div>
              <div>Read {fmtTime(row.observedAt)}</div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
