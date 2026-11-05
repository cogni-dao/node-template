// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/TimeSeriesCard`
 * Purpose: Pure, data-in presenter for one KPI time series: card, header slot,
 *   range toggle, gradient area, real gap textures, the proven "not yet
 *   measured" span, target band and line, pace and bet marks, tooltip,
 *   click-to-inspect selection and a readings table.
 * Scope: Client component. Draws a SeriesModel. Never fetches, never decides
 *   status, never fills a bucket.
 * Invariants: GAPS_STAY_GAPS (Area connectNulls={false}); RECHARTS_DIRECT_CHILDREN
 *   (Recharts 2.15.4 drops custom child components, so chart children are
 *   Recharts elements, a raw <defs> from chartDefs(), or arrays returned by
 *   plain functions); NAMED_FOCUSABLE_CHART (accessibilityLayer surface is
 *   aria-labelledby the visible title, with a focus-visible outline that needs
 *   outline-solid under Tailwind 4); NO_ANIMATION (animation hides dots);
 *   UNIQUE_IDS (sanitized useId); TABLE_IS_THE_KEYBOARD_PATH.
 * Side-effects: none
 * Links: ../lib/series.ts, ./chart-defs.tsx, ./HistoryChart.tsx
 * @public
 */

"use client";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@cogni/node-ui-kit/shadcn/chart";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@cogni/node-ui-kit/shadcn/toggle-group";
import { cn } from "@cogni/node-ui-kit/util/cn";
import Link from "next/link";
import {
  Fragment,
  type JSX,
  type ReactElement,
  type ReactNode,
  useId,
  useState,
} from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Dot,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import {
  floorToStep,
  formatDate,
  formatNumber,
  formatReadingTime,
  formatUtcTime,
  plural,
  unitLabel,
} from "../lib/presentation";
import type { PointState, SeriesModel, SeriesPoint } from "../lib/series";
import { type ChartIds, chartDefs, chartIds } from "./chart-defs";

const CHART_CONFIG = {
  value: { label: "Reading", color: "hsl(var(--chart-1))" },
  target: { label: "Target", color: "hsl(var(--foreground))" },
  pace: { label: "Needed pace", color: "hsl(var(--muted-foreground))" },
  bet: { label: "Bet", color: "hsl(var(--chart-4))" },
} satisfies ChartConfig;

/** The kit's outline-none sets --tw-outline-style: none; outline-solid restores it. */
const FOCUS_RING =
  "[&_.recharts-surface:focus-visible]:outline-solid [&_.recharts-surface:focus-visible]:outline-2 [&_.recharts-surface:focus-visible]:outline-ring [&_.recharts-surface:focus-visible]:outline-offset-2";

const STATE_TEXT: Record<Exclude<PointState, "ok">, string> = {
  missing: "No reading",
  error: "Read failed",
  unavailable: "Source unavailable",
};

const MISSING_TEXTURE =
  "repeating-linear-gradient(45deg, hsl(var(--muted-foreground) / 0.35) 0 1.5px, transparent 1.5px 5px)";
const FAILED_TEXTURE = `${MISSING_TEXTURE}, repeating-linear-gradient(135deg, hsl(var(--muted-foreground) / 0.55) 0 1.5px, transparent 1.5px 5px)`;

export interface TimeSeriesCardProps {
  readonly eyebrow: string;
  readonly description: string;
  /** Hero stat, status and caption. It speaks for the assessment, not the range. */
  readonly header: ReactNode;
  /** Visible chart title; names the chart surface. Includes the range. */
  readonly chartTitle: string;
  readonly ranges: readonly { readonly id: string; readonly label: string }[];
  readonly range: string;
  readonly onRangeChange: (id: string) => void;
  readonly model: SeriesModel | null;
  readonly status: "loading" | "ready" | "error";
  /** Showing the previous range while the selected one loads. */
  readonly stale: boolean;
  readonly onRetry: () => void;
  readonly inspectHref: (observationId: string) => string;
  readonly nowIso: string;
  /** False for a last-good value: the newest dot is drawn hollow. */
  readonly latestIsCurrent: boolean;
  readonly paceLabels: {
    readonly needed: string | null;
    readonly observed: string | null;
  };
}

export function TimeSeriesCard(props: TimeSeriesCardProps) {
  const { model } = props;
  const ids = chartIds(useId());
  const titleId = `${ids.fill}-title`;
  const summaryId = `${ids.fill}-summary`;
  const [selected, setSelected] = useState<SeriesPoint | null>(null);

  return (
    <section className="space-y-4 rounded-xl border border-border/60 bg-muted/10 p-4">
      <div className="space-y-2">
        <div className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
          {props.eyebrow}
        </div>
        <p className="text-muted-foreground text-xs">{props.description}</p>
        {props.header}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 id={titleId} className="text-muted-foreground text-sm">
            {props.chartTitle}
          </h4>
          {model && (model.layout === "sparse" || model.firstAttemptAt !== null) && (
            <p className="text-muted-foreground text-xs tabular-nums">
              {plural(model.okCount, "reading")} in range
              {model.firstAttemptAt !== null
                ? ` · measured since ${formatReadingTime(new Date(model.firstAttemptAt).toISOString(), props.nowIso)}`
                : ""}
            </p>
          )}
        </div>
        <ToggleGroup
          type="single"
          value={props.range}
          // Radix deselects the active item on a second click (""); keep the range.
          onValueChange={(v) => {
            if (v) {
              setSelected(null);
              props.onRangeChange(v);
            }
          }}
          aria-label="Chart range"
          className="rounded-lg border border-border/70 p-1"
        >
          {props.ranges.map((r) => (
            <ToggleGroupItem
              key={r.id}
              value={r.id}
              size="sm"
              className="h-7 px-2.5 text-xs tabular-nums"
            >
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <figure aria-labelledby={titleId} className="m-0 space-y-3">
        <p id={summaryId} className="sr-only">
          {model?.summary ?? ""}
        </p>
        {!model ? (
          props.status === "error" ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-border border-dashed px-4 text-center text-muted-foreground text-sm">
              History could not be read. This is unknown, not zero.
              <RetryButton onRetry={props.onRetry} />
            </div>
          ) : (
            <div className="h-48 animate-pulse rounded-xl bg-muted/60" />
          )
        ) : (
          <>
            {props.status === "error" && (
              <p
                role="status"
                className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs"
              >
                This range could not be read; the chart still shows the
                previous one. Its readings are unknown, not zero.
                <RetryButton onRetry={props.onRetry} />
              </p>
            )}
            <div
              className={cn(
                "relative transition-opacity motion-reduce:transition-none",
                props.stale && "opacity-60"
              )}
            >
              <ChartContainer
                config={CHART_CONFIG}
                className={cn("aspect-auto h-48 w-full", FOCUS_RING)}
              >
                <AreaChart
                  data={model.points as SeriesPoint[]}
                  margin={{ top: 20, right: 4, bottom: 0, left: 4 }}
                  accessibilityLayer
                  aria-labelledby={titleId}
                  aria-describedby={summaryId}
                  onClick={(state) => {
                    const p = state?.activePayload?.[0]?.payload as
                      | SeriesPoint
                      | undefined;
                    if (p?.observationId) setSelected(p);
                  }}
                >
                  {chartDefs(ids)}
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={[model.xDomain[0], model.xDomain[1]]}
                    allowDataOverflow
                    ticks={timeTicks(model)}
                    tickFormatter={(t: number) => tickText(t, model.step)}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={28}
                    tickMargin={8}
                  />
                  <YAxis
                    orientation="right"
                    domain={[model.yDomain[0], model.yDomain[1]]}
                    ticks={[...model.yTicks]}
                    allowDataOverflow
                    width={44}
                    tickFormatter={(v: number) => formatNumber(v, model.unit)}
                    tickLine={false}
                    axisLine={false}
                  />
                  {referenceMarks(model, ids, props.nowIso)}
                  <ChartTooltip
                    cursor={false}
                    filterNull={false}
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        hideIndicator
                        labelFormatter={(_, payload) => {
                          const p = payload?.[0]?.payload as
                            | SeriesPoint
                            | undefined;
                          return p ? pointTime(p, model.step, props.nowIso) : null;
                        }}
                        formatter={(_value, _name, item) => (
                          <TooltipValue
                            point={item.payload as SeriesPoint}
                            unit={model.unit}
                          />
                        )}
                      />
                    }
                  />
                  <Area
                    dataKey="value"
                    type="linear"
                    stroke="var(--color-value)"
                    strokeWidth={3}
                    fill={`url(#${ids.fill})`}
                    baseValue={model.yDomain[0]}
                    connectNulls={false}
                    isAnimationActive={false}
                    dot={(dot: DotProps) =>
                      renderDot(dot, model, props.latestIsCurrent)
                    }
                    activeDot={{
                      r: 4,
                      strokeWidth: 2,
                      stroke: "hsl(var(--background))",
                    }}
                  />
                </AreaChart>
              </ChartContainer>
              {model.empty && (
                <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-muted-foreground text-sm">
                  No readings in this range. This is unknown, not zero.
                </p>
              )}
            </div>
            <ChartLegend model={model} paceLabels={props.paceLabels} />
          </>
        )}
      </figure>

      {model && (
        <>
          <p aria-live="polite" className="min-h-4 text-xs tabular-nums">
            {selected?.observationId ? (
              <>
                <span className="text-muted-foreground">
                  {pointTime(selected, model.step, props.nowIso)} ·{" "}
                </span>
                {readingText(selected, model.unit)} ·{" "}
                <Link
                  href={props.inspectHref(selected.observationId)}
                  className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {selected.value === null
                    ? "Inspect failed attempt ↗"
                    : "Inspect reading ↗"}
                </Link>
              </>
            ) : null}
          </p>
          <ReadingsTable
            model={model}
            nowIso={props.nowIso}
            inspectHref={props.inspectHref}
          />
        </>
      )}
    </section>
  );
}

function RetryButton({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="rounded-md border border-border px-2 py-0.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      Try again
    </button>
  );
}

interface DotProps {
  readonly cx?: number;
  readonly cy?: number;
  readonly index?: number;
  readonly payload?: SeriesPoint;
}

/** Recharts calls this per point; a hidden point is a keyed Fragment, never raw SVG. */
function renderDot(
  props: DotProps,
  model: SeriesModel,
  latestIsCurrent: boolean
): JSX.Element {
  const key = `dot-${props.index ?? 0}`;
  const p = props.payload;
  if (!p || p.value === null || props.cx == null || props.cy == null)
    return <Fragment key={key} />;
  if (!(model.layout === "sparse" || p.isolated || p.latest))
    return <Fragment key={key} />;
  const hollow = p.latest && !latestIsCurrent;
  return (
    <Dot
      key={key}
      cx={props.cx}
      cy={props.cy}
      r={4}
      fill={hollow ? "hsl(var(--background))" : "var(--color-value)"}
      stroke={hollow ? "hsl(var(--muted-foreground))" : "hsl(var(--background))"}
      strokeWidth={2}
    />
  );
}

/** Reference marks as an array of Recharts elements (custom components would be dropped). */
function referenceMarks(
  model: SeriesModel,
  ids: ChartIds,
  nowIso: string
): ReactElement[] {
  const marks: ReactElement[] = [];
  const muted = "hsl(var(--muted-foreground))";
  if (model.band)
    marks.push(
      <ReferenceArea
        key="band"
        y1={model.band.y1}
        y2={model.band.y2}
        fill="var(--color-target)"
        fillOpacity={0.05}
        ifOverflow="hidden"
      />
    );
  if (model.notYetMeasured)
    marks.push(
      <ReferenceArea
        key="not-yet-measured"
        x1={model.notYetMeasured.x1}
        x2={model.notYetMeasured.x2}
        fill="hsl(var(--muted))"
        fillOpacity={0.6}
        ifOverflow="hidden"
        label={{
          value:
            model.firstAttemptAt !== null
              ? `Not yet measured · readings since ${formatReadingTime(new Date(model.firstAttemptAt).toISOString(), nowIso)}`
              : "Not yet measured",
          position: "insideBottomLeft",
          fontSize: 11,
          fill: muted,
        }}
      />
    );
  for (const g of model.gaps)
    marks.push(
      <ReferenceArea
        key={`gap-${g.x1}`}
        x1={g.x1}
        x2={g.x2}
        fill={`url(#${g.kind === "missing" ? ids.gapMissing : ids.gapFailed})`}
        fillOpacity={1}
        ifOverflow="hidden"
      />
    );
  for (const b of model.bets) {
    if (b.x1 !== null)
      marks.push(
        <ReferenceArea
          key={`bet-area-${b.id}`}
          x1={b.x1}
          x2={b.x2}
          ifOverflow="hidden"
          fill="var(--color-bet)"
          fillOpacity={0.1}
          stroke="var(--color-bet)"
          strokeOpacity={0.5}
          strokeDasharray="3 3"
          label={{
            value: b.label,
            position: "insideTopLeft",
            fontSize: 11,
            fill: muted,
          }}
        />
      );
    else if (b.inReach)
      marks.push(
        <ReferenceLine
          key={`bet-line-${b.id}`}
          x={b.x2}
          stroke="var(--color-bet)"
          strokeDasharray="3 3"
          label={{
            value: b.label,
            position: "insideTopRight",
            fontSize: 11,
            fill: muted,
          }}
        />
      );
    if (b.inReach) {
      const w = (model.xDomain[1] - model.xDomain[0]) * 0.03;
      marks.push(
        <ReferenceLine
          key={`bet-predicted-${b.id}`}
          segment={[
            { x: b.x2 - w, y: b.predicted },
            { x: b.x2, y: b.predicted },
          ]}
          stroke="var(--color-bet)"
          strokeWidth={2.5}
        />
      );
    }
  }
  marks.push(
    <ReferenceLine
      key="target"
      y={model.target.value}
      stroke="var(--color-target)"
      strokeWidth={1.5}
      strokeDasharray="6 4"
      label={{
        value: model.target.label,
        position: "insideBottomLeft",
        fontSize: 11,
        fontWeight: 600,
        fill: "hsl(var(--foreground))",
      }}
    />
  );
  if (model.deadlineX !== null)
    marks.push(
      <ReferenceLine
        key="deadline"
        x={model.deadlineX}
        stroke={muted}
        strokeDasharray="2 3"
        label={{ value: "Deadline", position: "insideTopRight", fontSize: 11, fill: muted }}
      />
    );
  const { needed, observed } = model.pace;
  if (needed)
    marks.push(
      <ReferenceLine
        key="pace-needed"
        segment={[
          { x: needed.x1, y: needed.y1 },
          { x: needed.x2, y: needed.y2 },
        ]}
        stroke="var(--color-pace)"
        strokeWidth={1.5}
        strokeDasharray="5 4"
        ifOverflow="hidden"
      />
    );
  if (observed)
    marks.push(
      <ReferenceLine
        key="pace-observed"
        segment={[
          { x: observed.x1, y: observed.y1 },
          { x: observed.x2, y: observed.y2 },
        ]}
        stroke="var(--color-value)"
        strokeOpacity={0.7}
        strokeWidth={2}
        strokeDasharray="1 4"
        strokeLinecap="round"
        ifOverflow="hidden"
      />
    );
  return marks;
}

function ChartLegend({
  model,
  paceLabels,
}: {
  readonly model: SeriesModel;
  readonly paceLabels: TimeSeriesCardProps["paceLabels"];
}) {
  const items: { key: string; swatch: ReactNode; text: string }[] = [];
  if (model.band)
    items.push({
      key: "band",
      swatch: <span className="h-2.5 w-3 rounded-[2px] bg-foreground/10" />,
      text: "Target zone",
    });
  if (model.pace.needed && paceLabels.needed)
    items.push({
      key: "needed",
      swatch: (
        <span className="w-3 border-muted-foreground border-t-2 border-dashed" />
      ),
      text: paceLabels.needed,
    });
  if (model.pace.observed && paceLabels.observed)
    items.push({
      key: "observed",
      swatch: (
        <span
          className="w-3 border-t-2 border-dotted"
          style={{ borderColor: "hsl(var(--chart-1))" }}
        />
      ),
      text: paceLabels.observed,
    });
  if (model.gapBuckets.missing)
    items.push({
      key: "missing",
      swatch: (
        <span
          className="h-2.5 w-3 rounded-[2px]"
          style={{ backgroundImage: MISSING_TEXTURE }}
        />
      ),
      text: "No reading",
    });
  if (model.gapBuckets.failed)
    items.push({
      key: "failed",
      swatch: (
        <span
          className="h-2.5 w-3 rounded-[2px]"
          style={{ backgroundImage: FAILED_TEXTURE }}
        />
      ),
      text: "Read failed",
    });
  if (model.notYetMeasured)
    items.push({
      key: "nym",
      swatch: <span className="h-2.5 w-3 rounded-[2px] bg-muted" />,
      text: "Not yet measured (no completed reading)",
    });
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs tabular-nums">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="flex items-center">
            {i.swatch}
          </span>
          {i.text}
        </li>
      ))}
    </ul>
  );
}

function ReadingsTable({
  model,
  nowIso,
  inspectHref,
}: {
  readonly model: SeriesModel;
  readonly nowIso: string;
  readonly inspectHref: (observationId: string) => string;
}) {
  const rows = [...model.points].reverse();
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Readings table · {plural(rows.length, "row")}
      </summary>
      <table className="mt-2 w-full text-left tabular-nums">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Time (UTC)</th>
            <th className="py-1 pr-3 font-medium">Reading</th>
            <th className="py-1 font-medium">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.t}-${p.latest}`} className="border-border/60 border-t">
              <td className="py-1 pr-3">{pointTime(p, model.step, nowIso)}</td>
              <td className="py-1 pr-3">{readingText(p, model.unit)}</td>
              <td className="py-1">
                {p.observationId ? (
                  <Link
                    href={inspectHref(p.observationId)}
                    className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Inspect ↗
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function TooltipValue({
  point,
  unit,
}: {
  readonly point: SeriesPoint;
  readonly unit: string;
}) {
  return (
    <div className="flex w-full items-center gap-2">
      <span
        aria-hidden="true"
        className="h-0.5 w-3 shrink-0 rounded"
        style={{ background: "var(--color-value)" }}
      />
      <span
        className={cn(
          "font-medium tabular-nums",
          point.value === null ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {readingText(point, unit)}
      </span>
      {point.observationId && (
        <span className="ml-auto pl-2 text-muted-foreground">
          Click to inspect
        </span>
      )}
    </div>
  );
}

/** A real 0 prints "0"; a non-ok bucket prints its status, never a number. */
export function readingText(p: SeriesPoint, unit: string): string {
  if (p.value === null)
    return STATE_TEXT[p.state === "ok" ? "missing" : p.state];
  return `${formatNumber(p.value, unit)} ${unitLabel(p.value, unit)}`;
}

function pointTime(
  p: SeriesPoint,
  step: SeriesModel["step"],
  nowIso: string
): string {
  const iso = new Date(p.t).toISOString();
  if (p.latest) return `Latest reading · ${formatReadingTime(iso, nowIso)}`;
  if (step === "1h") return `${formatDate(iso)}, ${formatUtcTime(iso)}`;
  if (step === "1w") return `Week of ${formatDate(iso, true)}`;
  return formatDate(iso, true);
}

function timeTicks(model: SeriesModel): number[] {
  const [x0, x1] = model.xDomain;
  const unit = model.step === "1h" ? "1h" : "1d";
  const out = new Set<number>();
  for (let i = 0; i < 5; i++) {
    const t = floorToStep(x0 + (i * (x1 - x0)) / 4, unit);
    if (t >= x0 && t <= x1) out.add(t);
  }
  return [...out];
}

function tickText(t: number, step: SeriesModel["step"]): string {
  const iso = new Date(t).toISOString();
  if (step === "1h" && !iso.endsWith("T00:00:00.000Z"))
    return formatUtcTime(iso).replace(" UTC", "");
  return formatDate(iso);
}
