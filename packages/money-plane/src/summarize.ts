// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: money-plane/summarize
 * Purpose: Exact cost-rate cohorts with explicit economic attribution and evidence basis.
 * Scope: Pure projection; no conversion, custody aggregation, authorization or ledger writes.
 * Invariants: Contract rates never become measured burn; unknown age never freshens a cohort.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-1ab1f013
 * @public
 */
import type { NativeRate } from "./types";

export type CostRateBasis =
  | { kind: "contract"; active: boolean }
  | { kind: "measured"; start: string; end: string };
export interface CostRateEvidence {
  sourceId: string;
  ownerId: string | null;
  scopeId: string | null;
  instrumentId: string | null;
  basis: CostRateBasis;
  rate: { amount: string | null; currency: string; per: NativeRate["per"] };
  sourceObservedAt: string | null;
  partial: boolean;
}
export interface CostRateCohort {
  ownerId: string;
  scopeId: string;
  instrumentId: string;
  basis:
    | { kind: "contract" }
    | { kind: "measured"; start: string; end: string };
  rate: { amount: string | null; currency: string; per: NativeRate["per"] };
  partial: boolean;
  oldestObservedAt: string | null;
  ageUnknown: boolean;
}
export interface CostRateSummary {
  cohorts: CostRateCohort[];
  unattributedCount: number;
}

interface Decimal {
  coefficient: bigint;
  scale: number;
}

/** Existing compute-cost coefficient/scale technique, extended to signed finite display values. */
function decimal(value: string | number): Decimal | null {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const text = String(value);
  if (text.length > 256) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 400) return null;
  const fraction = match[3] ?? "";
  const scale = fraction.length - exponent;
  const coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    scale,
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
  };
}

function display(value: Decimal): string {
  const sign = value.coefficient < 0n ? "-" : "";
  const digits = (
    value.coefficient < 0n ? -value.coefficient : value.coefficient
  )
    .toString()
    .padStart(value.scale + 1, "0");
  if (!value.scale) return `${sign}${digits}`;
  const fraction = digits.slice(-value.scale).replace(/0+$/, "");
  return `${sign}${digits.slice(0, -value.scale)}${fraction ? `.${fraction}` : ""}`;
}

/** Source instants must be explicit timestamps, never date-only observation windows. */
function instant(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function cohortFor(evidence: CostRateEvidence): CostRateCohort | null {
  const { ownerId, scopeId, instrumentId, rate } = evidence;
  if (
    !ownerId?.trim() ||
    !scopeId?.trim() ||
    !instrumentId?.trim() ||
    !rate.currency.trim() ||
    !["day", "month", "block"].includes(rate.per)
  )
    return null;
  let basis: CostRateCohort["basis"];
  if (evidence.basis.kind === "contract") basis = { kind: "contract" };
  else {
    const start = instant(evidence.basis.start);
    const end = instant(evidence.basis.end);
    if (!start || !end || start >= end) return null;
    basis = { kind: "measured", start, end };
  }
  return {
    ownerId,
    scopeId,
    instrumentId,
    basis,
    rate: { ...rate, amount: null },
    partial: false,
    oldestObservedAt: null,
    ageUnknown: false,
  };
}

/** One source granularity per report; identical repeats count once, conflicting repeats contribute no value. */
export function summarizeCostRates(
  evidence: readonly CostRateEvidence[]
): CostRateSummary {
  const result: CostRateSummary = { cohorts: [], unattributedCount: 0 };
  const sources = new Map<string, Map<string, CostRateEvidence>>();
  for (const item of evidence) {
    if (!item.sourceId.trim()) {
      result.unattributedCount += 1;
      continue;
    }
    const group =
      sources.get(item.sourceId) ?? new Map<string, CostRateEvidence>();
    // Fixed field order makes equality independent of caller object property order.
    const fingerprint = JSON.stringify([
      item.ownerId,
      item.scopeId,
      item.instrumentId,
      item.basis.kind,
      item.basis.kind === "contract"
        ? item.basis.active
        : [item.basis.start, item.basis.end],
      item.rate.amount,
      item.rate.currency,
      item.rate.per,
      item.sourceObservedAt,
      item.partial,
    ]);
    group.set(fingerprint, item);
    sources.set(item.sourceId, group);
  }
  const cohorts = new Map<
    string,
    { value: Decimal | null; cohort: CostRateCohort }
  >();
  for (const source of sources.values()) {
    const conflict = source.size > 1;
    for (const item of source.values()) {
      if (item.basis.kind === "contract" && !item.basis.active) continue;
      const candidate = cohortFor(item);
      if (!candidate) {
        result.unattributedCount += 1;
        continue;
      }
      const key = JSON.stringify([
        candidate.ownerId,
        candidate.scopeId,
        candidate.instrumentId,
        candidate.rate.currency,
        candidate.rate.per,
        candidate.basis,
      ]);
      const entry = cohorts.get(key) ?? { value: null, cohort: candidate };
      cohorts.set(key, entry);
      const value = item.rate.amount == null ? null : decimal(item.rate.amount);
      if (conflict || !value || value.coefficient < 0n)
        entry.cohort.partial = true;
      else
        entry.value = add(entry.value ?? { coefficient: 0n, scale: 0 }, value);
      entry.cohort.partial ||= item.partial;
      const observed = instant(item.sourceObservedAt);
      entry.cohort.ageUnknown ||= observed === null || conflict;
      if (
        observed &&
        (!entry.cohort.oldestObservedAt ||
          observed < entry.cohort.oldestObservedAt)
      )
        entry.cohort.oldestObservedAt = observed;
    }
  }
  result.cohorts = [...cohorts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => ({
      ...entry.cohort,
      rate: {
        ...entry.cohort.rate,
        amount: entry.value ? display(entry.value) : null,
      },
    }));
  return result;
}
