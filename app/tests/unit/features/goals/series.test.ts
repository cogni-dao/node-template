// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/goals/series`
 * Purpose: Prove the Goals chart model keeps gaps as gaps, crops only before a
 *   proven first attempt, keeps the target in view, draws pace from the
 *   assessment only, and that ranges, probe and hero labels follow the design.
 * Scope: Pure functions (lib/series.ts, lib/presentation.ts). No React, no network.
 * Invariants: GAPS_STAY_GAPS, UNKNOWN_IS_NOT_ZERO, CROP_ONLY_BEFORE_PROVEN_START,
 *   PACE_IS_DRAWN_NEVER_ASSESSED, HERO_SPEAKS_FOR_ASSESSMENT.
 * Side-effects: none
 * Links: app/src/features/goals/lib/series.ts, work item task.0040
 * @internal
 */

import type { KpiStatus } from "@cogni-dao/metrics/contracts";
import {
  assessmentFixture,
  history,
  PROD_AS_OF,
  productionMonthDaily,
  productionProbe,
  productionRatioAssessment,
  productionWeekHourly,
} from "@tests/_fixtures/goals/progress";
import { describe, expect, it } from "vitest";
import {
  allWindow,
  axisTickLabel,
  axisTicks,
  defaultRange,
  heroLabel,
  historyWindow,
  nextReadingAt,
  notYetMeasuredLabel,
  probeWindow,
  rangeWindow,
  seriesStartFromProbe,
  sparkSeries,
} from "@/features/goals/lib/presentation";
import { buildGoalSeries } from "@/features/goals/lib/series";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const t = (iso: string) => Date.parse(iso);
const OPEN_WEEK = t("2026-11-02T00:00:00.000Z");
const proven = (at: number) => ({ at, proven: true });
const OPEN = proven(OPEN_WEEK);
const LONG_AGO = proven(t("2026-10-01T00:00:00.000Z"));

function build(over: Partial<Parameters<typeof buildGoalSeries>[0]> = {}) {
  return buildGoalSeries({
    history: productionWeekHourly(),
    assessment: productionRatioAssessment(),
    asOf: PROD_AS_OF,
    seriesStart: OPEN,
    title: "Seven-day convergence ratio",
    rangeTitle: "past week",
    ...over,
  });
}

describe("series start probe", () => {
  it("is the start of the first non-missing week, else the open week", () => {
    expect(seriesStartFromProbe(productionProbe())).toEqual(OPEN);
    const probe = history("m", "ratio", "1w", "2026-11-02T00:00:00.000Z", [
      null,
      null,
      "error",
      0.5,
    ]);
    expect(seriesStartFromProbe(probe)).toEqual(
      proven(t("2026-10-19T00:00:00.000Z"))
    );
    // An attempt in the oldest probe week proves no start: older than the probe.
    const older = history("m", "ratio", "1w", "2026-11-02T00:00:00.000Z", [
      0.4,
      null,
      0.5,
    ]);
    expect(seriesStartFromProbe(older)).toEqual({
      at: t("2026-10-12T00:00:00.000Z"),
      proven: false,
    });
    const w = probeWindow(t(PROD_AS_OF));
    expect(w.step).toBe("1w");
    expect(w.to).toBe("2026-11-02T00:00:00.000Z");
    expect((t(w.to) - t(w.from)) / WEEK).toBe(400);
  });
});

describe("crop only before a proven first attempt (B1, N1)", () => {
  it("crops the production week at the first reading and shades only before it", () => {
    const m = build();
    expect(m.firstAttemptAt).toBe(t("2026-11-05T07:00:00.000Z"));
    // 07:00 → 10:00:03 is under 12 hours, so the axis extends left to 12 hours.
    const xData = t("2026-11-05T10:00:03.156Z");
    expect(m.xDomain[0]).toBe(xData - 12 * HOUR);
    expect(m.notYetMeasured).toEqual({
      x1: xData - 12 * HOUR,
      x2: t("2026-11-05T07:00:00.000Z"),
    });
    expect(m.gaps).toEqual([]);
    expect(m.points.map((p) => p.value)).toEqual([
      0.23863636363636365, 0.25, 0.25, 0.23157894736842105,
    ]);
    expect(m.points.at(-1)?.latest).toBe(true);
    expect(m.points.map((p) => p.lastOk)).toEqual([false, false, false, true]);
    expect(m.measuredSince).toBe(t("2026-11-05T07:00:00.000Z"));
    expect(m.summary).toContain("measured since 07:00 UTC");
    expect(m.layout).toBe("normal");
  });

  it("ends the 1M shade at history.to and leaves the open period unshaded", () => {
    const m = build({ history: productionMonthDaily(), rangeTitle: "past month" });
    const latest = t("2026-11-05T10:00:03.156Z");
    expect(m.firstAttemptAt).toBe(latest);
    expect(m.notYetMeasured?.x2).toBe(t("2026-11-05T00:00:00.000Z"));
    expect(m.xDomain[0]).toBe(latest - 12 * DAY);
    expect(m.gaps).toEqual([]);
    expect(m.points).toHaveLength(1);
    expect(m.layout).toBe("sparse");
    expect(m.points[0]?.isolated).toBe(true);
    // Daily resolution: the open-day point alone never claims a clock time.
    expect(m.measuredSince).toBe(t("2026-11-05T00:00:00.000Z"));
    expect(m.summary).toContain("measured since Nov 5;");
    expect(m.summary).not.toMatch(/measured since \d\d:\d\d/);
  });

  it("keeps a leading run as a gap when the series began before the range", () => {
    const specs = [...Array.from({ length: 21 }, () => null), 0.24, 0.25, 0.25];
    const m = build({
      history: history("m", "ratio", "1h", "2026-11-05T10:00:00.000Z", specs),
      rangeTitle: "past day",
    });
    expect(m.notYetMeasured).toBeNull();
    expect(m.firstAttemptAt).toBeNull();
    expect(m.xDomain[0]).toBe(t("2026-11-04T10:00:00.000Z"));
    expect(m.gaps).toEqual([
      {
        x1: t("2026-11-04T10:00:00.000Z"),
        x2: t("2026-11-05T07:00:00.000Z"),
        kind: "missing",
      },
    ]);
  });

  it("never crops or claims a start when the series is older than the probe", () => {
    const m = build({
      seriesStart: { at: t("2019-03-04T00:00:00.000Z"), proven: false },
    });
    expect(m.notYetMeasured).toBeNull();
    expect(m.firstAttemptAt).toBeNull();
    expect(m.summary).not.toContain("measured since");
  });

  it("never crops when the probe failed", () => {
    const m = build({ seriesStart: null });
    expect(m.notYetMeasured).toBeNull();
    expect(m.gaps[0]?.x1).toBe(t("2026-10-29T10:00:00.000Z"));
  });
});

describe("gaps stay gaps", () => {
  it("splits runs by kind and spans each from first start to last end", () => {
    const m = build({
      history: history("m", "ratio", "1h", "2026-11-05T10:00:00.000Z", [
        0.2,
        null,
        null,
        "error",
        "unavailable",
        0.3,
        null,
      ]),
      seriesStart: LONG_AGO,
    });
    const at = (h: number) => t("2026-11-05T03:00:00.000Z") + h * HOUR;
    expect(m.gaps).toEqual([
      { x1: at(1), x2: at(3), kind: "missing" },
      { x1: at(3), x2: at(5), kind: "failed" },
      { x1: at(6), x2: at(7), kind: "missing" },
    ]);
    expect(m.points.filter((p) => p.value === null)).toHaveLength(5);
    expect(m.points.find((p) => p.state === "error")?.observationId).toBeTruthy();
  });
});

describe("target band, domain and pace", () => {
  it("shades gte to the top, lte to the bottom, and eq not at all", () => {
    const gte = build();
    expect(gte.band).toEqual({ y1: 1, y2: gte.yDomain[1] });
    const lte = build({
      assessment: { ...productionRatioAssessment(), comparator: "lte" },
    });
    expect(lte.band).toEqual({ y1: lte.yDomain[0], y2: 1 });
    const eq = build({
      assessment: { ...productionRatioAssessment(), comparator: "eq" },
    });
    expect(eq.band).toBeNull();
    expect(gte.yDomain[0]).toBeLessThanOrEqual(0.23);
    expect(gte.yDomain[1]).toBeGreaterThanOrEqual(1);
  });

  it("anchors needed pace at asOf and reaches the target exactly at the deadline", () => {
    const asOf = PROD_AS_OF;
    const deadline = "2026-11-05T11:00:00.000Z";
    const value = 0.23157894736842105;
    const needed = ((1 - value) * WEEK) / (t(deadline) - t(asOf));
    const m = build({
      history: history(
        "m",
        "ratio",
        "1h",
        "2026-11-05T10:00:00.000Z",
        Array.from({ length: 24 }, (_, i) => (i > 20 ? 0.25 : null))
      ),
      seriesStart: LONG_AGO,
      assessment: {
        ...productionRatioAssessment(),
        deadline,
        pace: { observed: null, needed },
      },
    });
    // The line starts at the newest dot and keeps assessKpi's asOf math.
    const newest = t("2026-11-05T10:00:03.156Z");
    expect(m.pace.needed?.x1).toBe(newest);
    expect(m.pace.needed?.y1).toBeCloseTo(
      value + (needed * (newest - t(asOf))) / WEEK,
      12
    );
    expect(m.pace.needed?.x2).toBe(t(deadline));
    expect(m.pace.needed?.y2).toBeCloseTo(1, 9);
    expect(m.deadlineX).toBe(t(deadline));
    expect(m.pace.observed).toBeNull();
    expect(m.yDomain[1]).toBeGreaterThanOrEqual(1);
  });

  it("draws needed pace only when behind, and observed pace only when known", () => {
    const onTrack = build({
      assessment: {
        ...productionRatioAssessment(),
        status: "on_track",
        pace: { observed: 0.5, needed: -0.2 },
      },
    });
    expect(onTrack.pace.needed).toBeNull();
    expect(onTrack.pace.observed?.x1).toBe(t("2026-11-05T10:00:03.156Z"));
    const delayed = build({
      assessment: { ...productionRatioAssessment(), status: "delayed" },
    });
    expect(delayed.pace.needed).toBeNull();
    expect(build().pace.needed).not.toBeNull();
    expect(build().pace.observed).toBeNull();
  });
});

describe("pace overlap and label placement", () => {
  it("draws only needed pace when observed is within 10%, and flags the merge", () => {
    const close = build({
      assessment: {
        ...productionRatioAssessment(),
        pace: { observed: 0.059, needed: 0.062 },
      },
    });
    expect(close.pace.needed).not.toBeNull();
    expect(close.pace.observed).toBeNull();
    expect(close.pace.merged).toBe(true);
    expect(close.summary).toContain("observed pace +0.059 per week");
    const apart = build({
      assessment: {
        ...productionRatioAssessment(),
        pace: { observed: 0.02, needed: 0.062 },
      },
    });
    expect(apart.pace.observed).not.toBeNull();
    expect(apart.pace.merged).toBe(false);
  });

  it("moves the target label off the floor when the target sits low", () => {
    const low = build({
      history: history("m", "items", "1h", "2026-11-05T10:00:00.000Z", [21, 22, 22]),
      assessment: {
        ...productionRatioAssessment(),
        status: "on_track",
        value: 22,
        unit: "items",
        target: { value: 1, unit: "items" },
        pace: { observed: null, needed: -1.7 },
      },
    });
    expect(low.targetNearFloor).toBe(true);
    expect(build().targetNearFloor).toBe(false);
  });

  it("fits the not-yet-measured label inside its span or hides it", () => {
    expect(notYetMeasuredLabel(400, "07:00 UTC")).toBe(
      "Not yet measured · readings since 07:00 UTC"
    );
    expect(notYetMeasuredLabel(150, "07:00 UTC")).toBe("Not yet measured");
    expect(notYetMeasuredLabel(60, "07:00 UTC")).toBeNull();
  });

  it("names the day on every multi-day axis tick", () => {
    const at = t("2026-11-04T18:00:00.000Z");
    expect(axisTickLabel(at, "1h", 7 * DAY)).toBe("Nov 4, 18:00");
    expect(axisTickLabel(at, "1h", 12 * HOUR)).toBe("18:00");
    expect(axisTickLabel(t("2026-11-05T00:00:00.000Z"), "1h", 7 * DAY)).toBe(
      "Nov 5"
    );
    expect(axisTickLabel(t("2026-11-04T00:00:00.000Z"), "1d", 30 * DAY)).toBe(
      "Nov 4"
    );
    const ticks = axisTicks(t("2026-10-29T10:00:00.000Z"), t("2026-11-05T10:00:00.000Z"), "1h");
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    for (const x of ticks) expect(x % HOUR).toBe(0);
  });
});

describe("unknown is not zero", () => {
  it("prints a real 0 as 0 and an empty range as no readings", () => {
    const zero = build({
      history: history("m", "items", "1h", "2026-11-05T10:00:00.000Z", [0, 0, 0]),
      assessment: {
        ...productionRatioAssessment(),
        value: 0,
        unit: "items",
        observedAt: "2026-11-05T09:00:00.000Z",
        target: { value: 1, unit: "items" },
      },
      seriesStart: LONG_AGO,
    });
    expect(zero.summary).toContain("0 items");
    expect(zero.summary).not.toContain("no readings");

    const empty = build({
      history: history(
        "m",
        "ratio",
        "1h",
        "2026-11-05T10:00:00.000Z",
        Array.from({ length: 24 }, () => null)
      ),
      assessment: {
        ...productionRatioAssessment(),
        status: "delayed",
        value: null,
        observedAt: null,
        observationId: null,
      },
      seriesStart: LONG_AGO,
    });
    expect(empty.empty).toBe(true);
    expect(empty.okCount).toBe(0);
    expect(empty.summary).toContain("no readings in this range");
    // The domain comes from the target alone; no invented zero series.
    expect(empty.points.every((p) => p.value === null)).toBe(true);
  });
});

describe("ranges", () => {
  const now = t(PROD_AS_OF);

  it("reads hourly 1D/1W and daily 1M/3M, aligned and within 400 buckets", () => {
    for (const [range, step, n] of [
      ["1d", "1h", 24],
      ["1w", "1h", 168],
      ["1m", "1d", 30],
      ["3m", "1d", 90],
    ] as const) {
      const w = historyWindow(range, now);
      const size = step === "1h" ? HOUR : DAY;
      expect(w.step).toBe(step);
      expect(t(w.to) % size).toBe(0);
      expect((t(w.to) - t(w.from)) / size).toBe(n);
      expect(t(w.to)).toBeLessThanOrEqual(now);
    }
  });

  it("picks the All step from the proven start (N5 never sends from == to)", () => {
    const young = allWindow(OPEN, now);
    expect(young).toEqual({
      from: "2026-11-02T00:00:00.000Z",
      to: "2026-11-05T10:00:00.000Z",
      step: "1h",
    });
    expect(allWindow(proven(t("2026-06-01T00:00:00.000Z")), now).step).toBe("1d");
    const old = allWindow(proven(t("2010-01-04T00:00:00.000Z")), now);
    expect(old.step).toBe("1w");
    expect((t(old.to) - t(old.from)) / WEEK).toBe(400);
    expect(allWindow(null, now).step).toBe("1d");

    const mondayNow = t("2026-11-02T00:30:00.000Z");
    const monday = allWindow(OPEN, mondayNow);
    expect(t(monday.from)).toBeLessThan(t(monday.to));
    expect((t(monday.to) - t(monday.from)) / HOUR).toBe(12);
  });

  it("titles each window by what it actually reads", () => {
    expect(rangeWindow("1w", now, OPEN).title).toBe("past week, hourly");
    expect(rangeWindow("3m", now, OPEN).title).toBe("past 3 months, daily");
    expect(rangeWindow("all", now, OPEN).title).toBe("all time, hourly");
    const older = { at: t("2018-11-05T00:00:00.000Z"), proven: false };
    expect(rangeWindow("all", now, older)).toMatchObject({
      step: "1w",
      title: "last 400 weeks, weekly",
    });
    expect(rangeWindow("all", now, null).title).toBe("last 400 days, daily");
    expect(
      rangeWindow("all", now, proven(t("2010-01-04T00:00:00.000Z"))).title
    ).toBe("last 400 weeks, weekly");
  });

  it("opens hourly metrics on 1W and others on 1M", () => {
    expect(defaultRange(3600)).toBe("1w");
    expect(defaultRange(86_400)).toBe("1m");
    expect(defaultRange(null)).toBe("1m");
  });
});

describe("header", () => {
  it("labels the hero by what the reading is (R2)", () => {
    const at = "2026-11-02T10:00:00.000Z";
    const label = (status: KpiStatus) =>
      heroLabel({ status, value: 1, observedAt: at }, "2026-11-02T10:05:00.000Z");
    expect(label("met")).toBe("Final · 10:00 UTC");
    expect(label("missed")).toBe("Final · 10:00 UTC");
    expect(label("evaluating")).toBe("At deadline · 10:00 UTC");
    expect(label("on_track")).toBe("Latest · 10:00 UTC");
    expect(label("behind")).toBe("Latest · 10:00 UTC");
    expect(label("delayed")).toBe("Last good · 10:00 UTC");
    expect(label("failing")).toBe("Last good · 10:00 UTC");
    expect(label("building")).toBe("Last good · 10:00 UTC");
    expect(
      heroLabel(assessmentFixture("unresolved", { value: null, observedAt: null }), at)
    ).toBeNull();
  });

  it("states the next reading only while it is ahead", () => {
    expect(
      nextReadingAt("2026-11-05T10:00:03.156Z", 3600, PROD_AS_OF)
    ).toBe("2026-11-05T11:00:03.156Z");
    expect(nextReadingAt("2026-11-05T08:00:00.000Z", 3600, PROD_AS_OF)).toBeNull();
    expect(nextReadingAt("2026-11-05T10:00:00.000Z", null, PROD_AS_OF)).toBeNull();
  });
});

describe("sparkline data", () => {
  it("marks an isolated ok point and keeps an explicit domain", () => {
    const trend = history(
      "m",
      "ratio",
      "1d",
      "2026-11-06T00:00:00.000Z",
      [...Array.from({ length: 29 }, () => null), 0.23]
    );
    const s = sparkSeries(trend);
    expect(s.okCount).toBe(1);
    expect(s.data.at(-1)).toMatchObject({ value: 0.23, isolated: true, last: true });
    // The domain follows the readings (the target lives in the bullet).
    expect(s.domain[0]).toBeLessThan(0.23);
    expect(s.domain[1]).toBeGreaterThan(0.23);
    expect(s.domain[1]).toBeLessThan(1);
    expect(s.data.filter((d) => d.value === null)).toHaveLength(29);
  });
});
