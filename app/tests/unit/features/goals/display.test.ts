// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/goals/display`
 * Purpose: Prove KPI card numbers by display type: the author's choice wins,
 *   units pick a sane default, SLOs read as % with an error budget, volumes
 *   show a change only from two real readings, and unknown is never 0.
 * Scope: Pure functions in lib/display.ts.
 * Invariants: UNKNOWN_IS_NOT_ZERO; HINT_LE_3_WORDS.
 * Side-effects: none
 * Links: app/src/features/goals/lib/display.ts
 * @internal
 */

import { splitStoredMetricSpec } from "@cogni-dao/metrics/contracts";
import { assessmentFixture, history, kpiFixture } from "@tests/_fixtures/goals/progress";
import { describe, expect, it } from "vitest";

import { cardHint, cardNumber, displayOf, formatSlo, progressFraction } from "@/features/goals/lib/display";

const TO = "2026-11-03T00:00:00.000Z";

function k(unit: string, value: number | null, target: number, comparator: "gte" | "lte" = "gte", buckets = [1, 2]) {
  return kpiFixture(
    "m",
    "M",
    assessmentFixture("on_track", { unit, value, comparator, target: { value: target, unit } }),
    history("m", unit, "1d", TO, buckets)
  );
}

describe("display types", () => {
  it("lets the author choose and otherwise follows the unit", () => {
    expect(displayOf(k("ratio", 0.5, 1))).toBe("progress");
    expect(displayOf(k("%", 99.9, 99.5))).toBe("slo");
    expect(displayOf(k("stars", 10, 20))).toBe("volume");
    const chosen = k("items", 3, 5);
    expect(displayOf({ ...chosen, metric: chosen.metric && { ...chosen.metric, display: "progress" } })).toBe("progress");
  });

  it("reads an SLO as a percentage with an error budget", () => {
    const kpi = k("%", 99.95, 99.9);
    expect(cardNumber(kpi, "slo")).toEqual({ value: "99.95%", unit: "" });
    expect(cardHint(kpi, "slo")).toBe("budget 50%");
    expect(formatSlo(99.999)).toBe("99.999");
    expect(formatSlo(87.5)).toBe("87.5");
  });

  it("shows a volume change only from two real readings, gaps skipped", () => {
    expect(cardHint(k("stars", 130, 200, "gte", [100, null, 120]), "volume")).toBe("+30 · 3d");
    expect(cardHint(k("stars", 130, 200, "gte", [null, 120]), "volume")).toBe("≥ 200");
    expect(cardNumber(k("stars", 12_400, 20_000), "volume").value).toBe("12.4K");
  });

  it("never turns a missing reading into zero", () => {
    expect(cardNumber(k("ratio", null, 1), "progress").value).toBeNull();
    expect(progressFraction(k("ratio", null, 1))).toBeNull();
    expect(progressFraction(k("items", 50, 40, "lte"))).toBeCloseTo(0.8);
    expect(progressFraction(k("items", 30, 40, "lte"))).toBe(1);
  });

  it("keeps display beside the stored spec, outside the series hash", () => {
    expect(splitStoredMetricSpec({ calculatorId: "x@1", params: {}, maxAgeSeconds: 60, display: "volume" })).toEqual({
      spec: { calculatorId: "x@1", params: {}, maxAgeSeconds: 60 },
      display: "volume",
    });
    expect(splitStoredMetricSpec({ calculatorId: "x@1", display: "bogus" }).display).toBeUndefined();
  });
});
