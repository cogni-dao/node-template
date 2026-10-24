// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/row`
 * Purpose: Row helpers shared by readers and the snapshot runner: the UNKNOWN row, the grading floor, and safe detail text.
 * Scope: Pure functions. Does not perform IO.
 * Invariants: UNREADABLE_IS_UNKNOWN — `applyGradingFloor` demotes any GREEN/YELLOW row that carries a failure reason, any prepaid row with unmeasured burn, and any non-wallet INFO row, to UNKNOWN. Detail text never carries a URL and is ≤60 chars.
 * Side-effects: none
 * Links: src/snapshot.ts, src/readers/
 * @public
 */

import type { MoneyPlaneRow, PayAction, PlaneKind, ReasonCode } from "./types";

const DETAIL_MAX = 60;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const FAILURE_REASONS: ReadonlySet<ReasonCode> = new Set([
  "unconfigured",
  "unreadable",
  "timeout",
  "stale",
  "burn_unmeasured",
]);

/** Strip URLs (they may embed keys) and clamp to the row's detail budget. */
export function safeDetail(text: string): string {
  const clean = text.replace(URL_PATTERN, "<url>").replace(/\s+/g, " ").trim();
  return clean.length <= DETAIL_MAX
    ? clean
    : `${clean.slice(0, DETAIL_MAX - 1)}…`;
}

export interface UnknownRowInput {
  plane: string;
  label: string;
  kind: PlaneKind;
  reasonCode: ReasonCode;
  observedAt: string;
  detail?: string;
  payAction?: PayAction;
}

export function unknownRow(input: UnknownRowInput): MoneyPlaneRow {
  return {
    plane: input.plane,
    label: input.label,
    kind: input.kind,
    balance: null,
    currency: null,
    burnPerDay: null,
    runwayDays: null,
    grade: "UNKNOWN",
    observedAt: input.observedAt,
    reasonCode: input.reasonCode,
    ...(input.detail === undefined ? {} : { detail: safeDetail(input.detail) }),
    ...(input.payAction === undefined ? {} : { payAction: input.payAction }),
  };
}

/** A reader can over-grade; this floor makes an unmeasured plane UNKNOWN regardless of what it claimed. */
export function applyGradingFloor(row: MoneyPlaneRow): MoneyPlaneRow {
  // INFO means "holdings, no runway semantics" and is reserved for wallets; on any
  // other kind it would hide an ungraded plane from worstGrade.
  if (row.grade === "INFO" && row.kind !== "wallet") {
    return { ...row, grade: "UNKNOWN" };
  }
  if (row.grade !== "GREEN" && row.grade !== "YELLOW") return row;
  if (row.reasonCode !== undefined && FAILURE_REASONS.has(row.reasonCode)) {
    return { ...row, grade: "UNKNOWN" };
  }
  if (row.kind === "prepaid" && row.burnPerDay === null) {
    return { ...row, grade: "UNKNOWN", reasonCode: "burn_unmeasured" };
  }
  return row;
}
