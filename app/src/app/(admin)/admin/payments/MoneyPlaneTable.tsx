// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/MoneyPlaneTable`
 * Purpose: One table, one row per money plane: balance, burn/day, runway, grade, last read, action.
 * Scope: Server component rendering `@cogni/money-plane` rows. The only interactive cell is the
 *   `fund-steward` action (client island); external actions are plain links. Does not fetch.
 * Invariants: ONE_ROW_MODEL — renders MoneyPlaneRow as-is; a new action is one `payAction` case here, not a new row shape.
 *   UNKNOWN shows its reason, never a GREEN badge. Product UI stays local to this node (not node-ui-kit).
 * Side-effects: none
 * Links: packages/money-plane/src/types.ts, FundStewardAction.client.tsx
 * @public
 */

import type { Grade, MoneyPlaneRow, PayAction } from "@cogni/money-plane";
import { Badge } from "@cogni/node-ui-kit/reui/badge";
import { ExternalLink } from "lucide-react";
import type { ReactElement } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";

import { FundStewardAction } from "./FundStewardAction.client";

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
  return `${iso.slice(11, 16)} UTC`;
}

function Action({ row }: { row: MoneyPlaneRow }): ReactElement | null {
  const action: PayAction | undefined = row.payAction;
  if (!action) return null;
  switch (action.kind) {
    case "fund-steward":
      return <FundStewardAction disabled={row.reasonCode === "unconfigured"} />;
    case "external":
    case "steward-checkout": {
      const href = action.kind === "external" ? action.url : action.checkoutUrl;
      const label =
        action.kind === "external" ? action.label : `Pay ${action.vendor}`;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary text-sm hover:underline"
        >
          {label}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      );
    }
  }
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
          <TableHead>Plane</TableHead>
          <TableHead className="text-right">Balance</TableHead>
          <TableHead className="text-right">Burn/day</TableHead>
          <TableHead className="text-right">Runway</TableHead>
          <TableHead>Grade</TableHead>
          <TableHead>Last read</TableHead>
          <TableHead className="text-right">Action</TableHead>
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
              <div className="font-mono text-muted-foreground text-xs">
                {row.plane}
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
              {row.kind === "wallet"
                ? "n/a"
                : fmtAmount(row.burnPerDay, row.currency)}
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
            <TableCell className="font-mono text-muted-foreground text-xs">
              {fmtTime(row.observedAt)}
            </TableCell>
            <TableCell className="text-right">
              <Action row={row} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
