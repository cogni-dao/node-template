// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/goals/goals-tab`
 * Purpose: Prove the Goals tab shows every KPI status as a symbol plus a word,
 *   says "unknown, not zero" for missing readings, keeps stale data labeled
 *   "not current" after a failed refresh, is a URL-addressable Knowledge tab,
 *   and that the Recharts history card keeps gaps, a named focusable chart,
 *   resolvable SVG ids, a range-independent hero and an evidence path.
 * Scope: React Query plus the browser fetch boundary. No live network.
 *   recharts ResponsiveContainer is mocked to a fixed size so jsdom renders SVG.
 * Invariants: STATUS_NEVER_COLOR_ONLY, UNKNOWN_IS_NOT_ZERO, ONE_ALERT_ON_FAILURE,
 *   WAI_ARIA_TABS, URL_DRIVEN_MODE.
 * Side-effects: global (stubbed fetch)
 * Links: app/src/features/goals/components/GoalsBoard.tsx, app/src/app/(app)/knowledge/view.tsx
 * @vitest-environment jsdom
 * @internal
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type GoalsProgress,
  GoalsProgressSchema,
  type KpiAssessment,
} from "@cogni-dao/metrics/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type BucketSpec,
  everyStatusFixture,
  goalFixture,
  history,
  kpiFixture,
  PROD_AS_OF,
  productionRatioAssessment,
  visualFixture,
} from "@tests/_fixtures/goals/progress";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeDashboardView } from "@/app/(app)/knowledge/view";
import { GoalsBoard, MetricEvidence } from "@/features/goals";
import { readingText } from "@/features/goals/components/TimeSeriesCard";
import { deadlineText, STATUS_META } from "@/features/goals/lib/presentation";

const navigation = vi.hoisted(() => ({
  mode: "browse",
  observation: null as string | null,
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () =>
    new URLSearchParams({
      mode: navigation.mode,
      ...(navigation.observation
        ? { observation: navigation.observation }
        : {}),
    }),
}));
// jsdom measures 0×0, so a real ResponsiveContainer renders nothing.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const React = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      React.createElement(
        "div",
        { style: { width: 800, height: 192 } },
        React.cloneElement(children as ReactElement<Record<string, unknown>>, {
          width: 800,
          height: 192,
        })
      ),
  };
});
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid", () => ({
  DataGrid: () => null,
  DataGridContainer: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock(
  "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility",
  () => ({ DataGridColumnVisibility: () => null })
);
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-pagination", () => ({
  DataGridPagination: () => null,
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-table", () => ({
  DataGridTable: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/AddDomainSheet", () => ({
  AddDomainSheet: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/KnowledgeDetail", () => ({
  KnowledgeDetail: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/GraphView", () => ({
  GraphView: () => null,
}));
vi.mock("@/components", () => ({
  Button: ({ children, onClick }: ComponentProps<"button">) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

function client() {
  return new QueryClient({
    // retryDelay 0: the history queries retry once; tests need not wait 1 s.
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigation.push.mockReset();
  navigation.observation = null;
});

describe("GoalsBoard", () => {
  it("renders every KPI status as a symbol plus a word", () => {
    const data = everyStatusFixture();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = render(
      <QueryClientProvider client={client()}>
        <GoalsBoard initialData={data} />
      </QueryClientProvider>
    );
    for (const [status, meta] of Object.entries(STATUS_META)) {
      const pill = container.querySelector(
        `[data-goal="goal-${status}"] [data-status="${status}"]`
      );
      expect(pill, status).not.toBeNull();
      expect(pill?.textContent).toContain(meta.symbol);
      expect(pill?.textContent).toMatch(meta.short);
    }
    // Not measured is unknown, never zero; the reason is plain words.
    const notMeasured = container.querySelector(
      '[data-goal="goal-not_measured"]'
    ) as HTMLElement;
    expect(notMeasured.textContent).toContain("unknown, not zero");
    expect(notMeasured.textContent).toContain(
      "Its calculator is not installed on this node."
    );
    // Every small mark states its values and target in words, and every
    // chart SVG sits inside such a labelled wrapper.
    const marks = container.querySelectorAll('[role="img"]');
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks)
      expect(mark.getAttribute("aria-label")).toMatch(/target/);
    const surfaces = container.querySelectorAll("svg.recharts-surface");
    expect(surfaces.length).toBeGreaterThan(0);
    for (const svg of surfaces)
      expect(svg.closest('[role="img"]'), "chart outside a labelled mark").not.toBeNull();
    expect(screen.queryByText(/\b1 days\b/)).toBeNull();
  });

  it("keeps the last data labeled not current behind one alert when a refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    );
    const c = client();
    render(
      <QueryClientProvider client={c}>
        <GoalsBoard initialData={visualFixture()} />
      </QueryClientProvider>
    );
    await c.refetchQueries({ queryKey: ["goals", "progress"] });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not current/);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Not current")).toBeTruthy();
    expect(
      screen.getByText("AI work converges faster than it sprawls")
    ).toBeTruthy();
  });

  it("expands a row from its title button", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(
      <QueryClientProvider client={client()}>
        <GoalsBoard initialData={visualFixture()} />
      </QueryClientProvider>
    );
    const toggle = screen.getByRole("button", {
      name: "AI work converges faster than it sprawls",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const detail = document.getElementById(
      toggle.getAttribute("aria-controls") as string
    ) as HTMLElement;
    expect(within(detail).getByText("Inspect reading ↗")).toBeTruthy();
    // Hourly metrics open on the hourly week.
    expect(
      within(detail).getByRole("radio", { name: "1W", checked: true })
    ).toBeTruthy();
  });
});

describe("Knowledge Goals tab", () => {
  it("is a WAI-ARIA tab that writes ?mode=goals and shows the attention badge", async () => {
    navigation.mode = "browse";
    const data = visualFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/metrics/goals") return Response.json(data);
        if (url.startsWith("/api/v1/knowledge/contributions"))
          return Response.json({ contributions: [] });
        return new Promise(() => {});
      })
    );
    const qc = client();
    const view = () => (
      <QueryClientProvider client={qc}>
        <KnowledgeDashboardView
          initialList={{ items: [], domains: [] }}
          initialDomains={{ domains: [] }}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(view());
    const tablist = screen.getByRole("tablist", { name: "Knowledge views" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/,.*$/, ""))).toEqual([
      "Browse",
      "Graph",
      "Chains",
      "Domains",
      expect.stringMatching(/^Goals/),
      "Inbox",
    ]);
    const goals = within(tablist).getByRole("tab", { name: /^Goals/ });
    await waitFor(() =>
      expect(goals.textContent).toContain("1 goal needs attention")
    );
    expect(goals.getAttribute("aria-selected")).toBe("false");
    expect(goals.getAttribute("tabindex")).toBe("-1");

    fireEvent.click(goals);
    expect(navigation.push).toHaveBeenCalledWith("/knowledge?mode=goals", {
      scroll: false,
    });
    expect(goals.getAttribute("aria-selected")).toBe("true");
    // Re-selecting the current tab adds no history entry.
    fireEvent.click(goals);
    expect(navigation.push).toHaveBeenCalledTimes(1);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(goals.id);
    expect(
      within(panel).getByRole("region", { name: "Goals" })
    ).toBeTruthy();

    // Arrow keys move focus along the tablist (manual activation).
    goals.focus();
    fireEvent.keyDown(goals, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toMatch(/^Inbox/);

    // Back/forward: the URL changes under the view and the tab follows it.
    navigation.mode = "goals";
    rerender(view());
    navigation.mode = "browse";
    rerender(view());
    expect(
      within(tablist)
        .getByRole("tab", { name: "Browse" })
        .getAttribute("aria-selected")
    ).toBe("true");
    navigation.mode = "goals";
    rerender(view());
    expect(goals.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(within(tablist).getByRole("tab", { name: "Browse" }));
    expect(navigation.push).toHaveBeenLastCalledWith("/knowledge", {
      scroll: false,
    });
  });
});

describe("MetricEvidence", () => {
  it("pins the linked immutable reading ahead of newer rolling readings", async () => {
    const reading = (n: number, value: number) => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      metricId: "work",
      definitionRevision: "1",
      definitionHash: "hash1",
      calculatorVersion: "work.count@1",
      paramsHash: "params1",
      node: "test",
      environment: "test",
      dataScope: "test",
      window: { start: "2026-11-02T00:00:00Z", end: `2026-11-02T0${n}:00:00Z` },
      sourceWatermarks: [{ source: "work", asOf: "2026-11-02T00:00:00Z" }],
      observedAt: `2026-11-02T0${n}:00:00Z`,
      status: "ok",
      value,
      unit: "items",
      reason: null,
      evidenceRefs: ["node:work"],
    });
    const pinned = reading(1, 5);
    const later = reading(2, 20);
    const definition = {
      id: "work",
      title: "Work",
      revision: "1",
      spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 60 },
    };
    navigation.observation = pinned.id;
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/v1/metrics/work"
        ? Response.json({
            definition,
            latestAttempt: later,
            lastGood: later,
            viewState: "ok",
            history: [later, pinned],
          })
        : url === `/api/v1/metrics/work/observations/${pinned.id}`
          ? Response.json({ definition, observation: pinned })
          : new Response("{}", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <QueryClientProvider client={client()}>
        <MetricEvidence id="work" />
      </QueryClientProvider>
    );
    await screen.findByText(/Linked immutable evidence/);
    const articles = container.querySelectorAll("article");
    expect(articles).toHaveLength(1);
    expect(articles[0]?.id).toBe(`observation-${pinned.id}`);
    expect(articles[0]?.textContent).toContain("5 items");
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      "/api/v1/metrics/work",
      `/api/v1/metrics/work/observations/${pinned.id}`,
    ]);
  });
});

describe("goal deadline summary", () => {
  it("never reports a passed deadline as next due", () => {
    const now = "2026-11-04T06:00:00.000Z";
    expect(
      deadlineText(["2026-10-24T23:59:00.000Z", "2027-01-31T00:00:00.000Z"], 3, now)
    ).toBe("next due Jan 31, 2027 (88 days) · 1 past due");
    expect(deadlineText(["2026-10-24T23:59:00.000Z"], 1, now)).toBe("1 past due");
  });
});

// ------------------------------------------------- history card (task.0040)

const HOUR = 3_600_000;
const NOV5 = Date.parse("2026-11-05T00:00:00.000Z");

type Spec = (start: number, step: string) => BucketSpec;

/** Production shape: 07 and 09 UTC ok, 08 UTC a failed read, nothing else. */
const productionSpec: Spec = (start, step) =>
  step !== "1h"
    ? null
    : start === NOV5 + 7 * HOUR
      ? 0.23863636363636365
      : start === NOV5 + 8 * HOUR
        ? "error"
        : start === NOV5 + 9 * HOUR
          ? 0.25
          : null;

function board(
  over: Partial<KpiAssessment> = {},
  trendValue: number | null = 0.23157894736842105
): GoalsProgress {
  const a = { ...productionRatioAssessment(), ...over };
  return GoalsProgressSchema.parse({
    asOf: PROD_AS_OF,
    environment: "production",
    goals: [
      goalFixture(
        "goal-ai-work-converges",
        "AI work converges faster than it sprawls",
        [
          kpiFixture(
            "convergence-ratio-7d",
            "Seven-day convergence ratio",
            a,
            history(
              "convergence-ratio-7d",
              "ratio",
              "1d",
              "2026-11-06T00:00:00.000Z",
              [...Array.from({ length: 29 }, () => null), trendValue]
            )
          ),
        ]
      ),
    ],
  });
}

/** Serves any aligned history window from a bucket spec; 400 × 1w probes are all missing. */
function historyServer(spec: Spec = productionSpec, failHistory = false) {
  return vi.fn(async (url: string) => {
    const u = new URL(url, "http://local");
    const match = u.pathname.match(/^\/api\/v1\/metrics\/([^/]+)\/history$/);
    if (!match) return new Promise<Response>(() => {});
    const step = u.searchParams.get("step") as "1h" | "1d" | "1w";
    if (failHistory && step !== "1w")
      return new Response("{}", { status: 503 });
    const from = Date.parse(u.searchParams.get("from") ?? "");
    const to = Date.parse(u.searchParams.get("to") ?? "");
    const size = { "1h": HOUR, "1d": 24 * HOUR, "1w": 168 * HOUR }[step];
    const specs = Array.from({ length: (to - from) / size }, (_, i) =>
      spec(from + i * size, step)
    );
    return Response.json(
      history(decodeURIComponent(match[1] ?? ""), "ratio", step, new Date(to).toISOString(), specs)
    );
  });
}

async function openChart(data: GoalsProgress, fetchMock = historyServer()) {
  vi.stubGlobal("fetch", fetchMock);
  const utils = render(
    <QueryClientProvider client={client()}>
      <GoalsBoard initialData={data} goalId={data.goals[0]?.id} />
    </QueryClientProvider>
  );
  await waitFor(() =>
    expect(
      utils.container.querySelector("figure svg.recharts-surface")
    ).not.toBeNull()
  );
  return { ...utils, fetchMock };
}

const chartSvg = (c: HTMLElement) =>
  c.querySelector("figure svg.recharts-surface") as SVGSVGElement;

describe("goal history card", () => {
  it("keeps the hero and pill identical across all five ranges", async () => {
    const { container } = await openChart(board());
    const heroes: string[] = [];
    for (const name of ["1D", "1W", "1M", "3M", "All"]) {
      fireEvent.click(screen.getByRole("radio", { name }));
      await waitFor(() =>
        expect(screen.getByRole("radio", { name, checked: true })).toBeTruthy()
      );
      await waitFor(() => expect(chartSvg(container)).not.toBeNull());
      heroes.push(
        (container.querySelector("[data-hero]") as HTMLElement).textContent ?? ""
      );
    }
    expect(new Set(heroes).size).toBe(1);
    expect(heroes[0]).toContain("0.23");
    expect(heroes[0]).toContain("Latest · 10:00 UTC");
    expect(heroes[0]).toContain("Behind pace");
    expect(heroes[0]).not.toMatch(/past week|past day|all time/i);
  });

  it("names the focusable chart surface by its visible title", async () => {
    const { container } = await openChart(board());
    const svg = chartSvg(container);
    expect(svg.getAttribute("tabindex")).toBe("0");
    // Foreground ink (not the ring token) keeps the outline at 3:1 in dark mode.
    expect(
      (svg.closest("[data-chart]") as HTMLElement).className
    ).toContain("[&_.recharts-surface:focus-visible]:outline-foreground");
    const title = document.getElementById(
      svg.getAttribute("aria-labelledby") as string
    );
    expect(title?.textContent).toBe(
      "Seven-day convergence ratio · past week, hourly"
    );
    const summary = document.getElementById(
      svg.getAttribute("aria-describedby") as string
    );
    expect(summary?.textContent).toMatch(/target ≥ 1.00 by Jan 31/);
    expect(summary?.textContent).toMatch(/1 hour with a failed read/);
    expect(summary?.textContent).toMatch(/measured since 07:00 UTC/);
    expect(
      container.querySelector("figure")?.getAttribute("aria-labelledby")
    ).toBe(title?.id);
  });

  it("resolves every url(#id) inside the same svg, with ids unique per chart", async () => {
    vi.stubGlobal("fetch", historyServer());
    const data = board();
    const { container } = render(
      <QueryClientProvider client={client()}>
        <GoalsBoard initialData={data} goalId="goal-ai-work-converges" />
        <GoalsBoard initialData={data} goalId="goal-ai-work-converges" />
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(container.querySelectorAll("figure svg.recharts-surface")).toHaveLength(2)
    );
    const ids: string[] = [];
    for (const svg of container.querySelectorAll("figure svg.recharts-surface")) {
      // Every url(#id) in any attribute (fill, stroke, clip-path).
      const refs = [...svg.querySelectorAll("*")].flatMap((el) =>
        [...el.attributes].flatMap((attr) =>
          [...attr.value.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1] as string)
        )
      );
      const own = refs.filter((id) => id.startsWith("goal-chart-"));
      expect(own.some((id) => id.endsWith("-fill"))).toBe(true);
      expect(own.some((id) => id.endsWith("-gap-failed"))).toBe(true);
      for (const id of refs)
        expect(svg.querySelector(`[id="${id}"]`), id).not.toBeNull();
      ids.push(...[...svg.querySelectorAll("defs [id]")].map((el) => el.id));
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("breaks the rendered area at a gap instead of bridging it", async () => {
    const { container } = await openChart(board());
    const d =
      container.querySelector("figure .recharts-area-curve")?.getAttribute("d") ??
      "";
    // 07:00 | failed 08:00 | 09:00 → latest: two separate segments.
    expect(d.match(/M/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("Read failed");
  });

  it("keeps the range on a second click of the active item", async () => {
    const { fetchMock } = await openChart(board());
    const calls = fetchMock.mock.calls.length;
    const active = screen.getByRole("radio", { name: "1W", checked: true });
    fireEvent.click(active);
    expect(screen.getByRole("radio", { name: "1W", checked: true })).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("links every reading in the table and selects a clicked point", async () => {
    const { container } = await openChart(board());
    const details = container.querySelector("figure ~ details, details") as HTMLDetailsElement;
    // Rows render only while the table is open.
    expect(details.querySelector("table")).toBeNull();
    details.open = true;
    fireEvent(details, new Event("toggle"));
    const table = await waitFor(() => {
      const t = details.querySelector("table");
      expect(t).not.toBeNull();
      return t as HTMLElement;
    });
    const hrefs = [...table.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(
      "/knowledge/convergence-ratio-7d?observation=861a7b59-3915-4484-b0c8-0872cbf42a7d"
    );
    expect(table.textContent).toContain("Read failed");
    // Click the newest reading's dot (the last one); the panel links its evidence.
    const dots = container.querySelectorAll("figure .recharts-dot");
    const dot = dots[dots.length - 1] as SVGElement;
    const wrapper = container.querySelector("figure .recharts-wrapper") as HTMLElement;
    fireEvent.click(wrapper, {
      clientX: Number(dot.getAttribute("cx")),
      clientY: Number(dot.getAttribute("cy")),
    });
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement;
    await waitFor(() => expect(within(live).getByRole("link")).toBeTruthy());
    expect(within(live).getByRole("link").getAttribute("href")).toBe(
      "/knowledge/convergence-ratio-7d?observation=861a7b59-3915-4484-b0c8-0872cbf42a7d"
    );
  });

  it("inspects the active point with Enter from the keyboard", async () => {
    const { container } = await openChart(board());
    const svg = chartSvg(container);
    // Focus starts the accessibility layer at the first point (07:00).
    fireEvent.focus(svg);
    fireEvent.keyDown(svg, { key: "Enter" });
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement;
    await waitFor(() => expect(within(live).getByRole("link")).toBeTruthy());
    expect(live.textContent).toContain("07:00 UTC");
  });

  it("draws a delayed metric's last good reading as a hollow dot", async () => {
    const { container } = await openChart(
      board({ status: "delayed", observedAt: "2026-11-05T09:00:03.000Z" })
    );
    const hollow = [...container.querySelectorAll("figure .recharts-dot")].filter(
      (d) => d.getAttribute("fill") === "hsl(var(--background))"
    );
    expect(hollow).toHaveLength(1);
    expect((container.querySelector("[data-hero]") as HTMLElement).textContent).toContain(
      "Last good · 09:00 UTC"
    );
  });

  it("draws one pace line when observed is close to needed, naming both", async () => {
    const { container } = await openChart(
      board({ pace: { observed: 0.06, needed: 0.062 } })
    );
    expect(container.textContent).toContain("Needed pace +0.062 / wk");
    expect(container.textContent).toContain(
      "Observed pace +0.06 / wk (close to needed; drawn as one line)"
    );
    // Target line plus one pace segment.
    expect(
      container.querySelectorAll("figure .recharts-reference-line")
    ).toHaveLength(2);
  });

  it("opens a chart with exactly one probe and one range read", async () => {
    const { fetchMock } = await openChart(board());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const steps = fetchMock.mock.calls.map(([url]) =>
      new URL(url as string, "http://local").searchParams.get("step")
    );
    expect(steps.sort()).toEqual(["1h", "1w"]);
  });

  it("says it could not refresh and keeps the last read on a failed refetch", async () => {
    const qc = client();
    let fail = false;
    const ok = historyServer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        fail && !url.includes("step=1w") ? new Response("{}", { status: 503 }) : ok(url)
      )
    );
    const { container } = render(
      <QueryClientProvider client={qc}>
        <GoalsBoard initialData={board()} goalId="goal-ai-work-converges" />
      </QueryClientProvider>
    );
    await waitFor(() => expect(chartSvg(container)).not.toBeNull());
    fail = true;
    await qc.refetchQueries({ queryKey: ["metrics", "history"] });
    expect(
      await screen.findByText(/Could not refresh; showing the last read\./)
    ).toBeTruthy();
    expect(chartSvg(container)).not.toBeNull();
  });

  it("prints a real 0 and never draws a zero line for a missing reading", async () => {
    const zero = { t: 0, value: 0, state: "ok", observationId: null, latest: false, isolated: true } as const;
    expect(readingText(zero, "items")).toBe("0 items");
    expect(readingText({ ...zero, value: null, state: "missing" }, "items")).toBe(
      "No reading"
    );
    const { container } = await openChart(
      board(
        { status: "delayed", value: null, observedAt: null, observationId: null },
        null
      ),
      historyServer(() => null)
    );
    const overlay = screen.getByText(
      "No readings in this range. This is unknown, not zero."
    );
    // A background pill keeps the target line from striking through it.
    expect(overlay.className).toMatch(/bg-background/);
    // The chart rendered (target line present), but no series and no zero line.
    expect(chartSvg(container)).not.toBeNull();
    for (const el of container.querySelectorAll(
      "figure .recharts-area-curve, figure .recharts-area-area"
    ))
      expect(el.getAttribute("d") ?? "").toBe("");
    const lines = container.querySelectorAll("figure .recharts-reference-line");
    expect(lines).toHaveLength(1); // the target only
    const zeroTick = [
      ...container.querySelectorAll("figure .recharts-yAxis .recharts-cartesian-axis-tick-value"),
    ].find((el) => el.textContent === "0");
    const targetY = lines[0]?.querySelector("line")?.getAttribute("y1");
    expect(targetY).not.toBe(zeroTick?.getAttribute("y") ?? "none");
    expect((container.querySelector("[data-hero]") as HTMLElement).textContent).toContain(
      "—"
    );
  });

  it("keeps the frame and says unknown when history cannot be read", async () => {
    vi.stubGlobal("fetch", historyServer(productionSpec, true));
    render(
      <QueryClientProvider client={client()}>
        <GoalsBoard initialData={board()} goalId="goal-ai-work-converges" />
      </QueryClientProvider>
    );
    expect(
      await screen.findByText(
        /History could not be read\. This is unknown, not zero\./
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "1W", checked: true })).toBeTruthy();
    // The title keeps its range words even though no data arrived.
    expect(
      screen.getByRole("heading", {
        name: "Seven-day convergence ratio · past week, hourly",
      })
    ).toBeTruthy();
  });

  it("labels final and at-deadline readings in the hero", async () => {
    for (const [status, label] of [
      ["met", "Final · 10:00 UTC"],
      ["missed", "Final · 10:00 UTC"],
      ["evaluating", "At deadline · 10:00 UTC"],
    ] as const) {
      const data = everyStatusFixture();
      vi.stubGlobal("fetch", historyServer(() => null));
      const { container, unmount } = render(
        <QueryClientProvider client={client()}>
          <GoalsBoard initialData={data} goalId={`goal-${status}`} />
        </QueryClientProvider>
      );
      expect(
        (container.querySelector("[data-hero]") as HTMLElement).textContent
      ).toContain(label);
      unmount();
    }
  });

  it("draws an isolated sparkline reading as a Recharts dot", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = render(
      <QueryClientProvider client={client()}>
        <GoalsBoard initialData={board()} />
      </QueryClientProvider>
    );
    const spark = [...container.querySelectorAll('[role="img"]')].find((el) =>
      el.getAttribute("aria-label")?.startsWith("Last 30 days")
    ) as HTMLElement;
    expect(spark.getAttribute("aria-label")).toContain("one reading, 0.23");
    expect(spark.getAttribute("aria-label")).toContain("target ≥ 1.00");
    expect(spark.querySelectorAll(".recharts-dot")).toHaveLength(1);
    // A gradient area (poly recipe), no dashed placeholder line.
    expect(spark.querySelector(".recharts-area")).not.toBeNull();
    expect(spark.querySelector(".recharts-reference-line")).toBeNull();
    const fill = spark.querySelector(".recharts-area-area")?.getAttribute("fill") ?? "";
    const id = fill.replace(/^url\(#(.*)\)$/, "$1");
    expect(id).not.toBe("");
    expect(spark.querySelector(`[id="${id}"]`)).not.toBeNull();
  });

  it("shows no trend at all for a goal with no bound metric", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = render(
      <QueryClientProvider client={client()}>
        <GoalsBoard initialData={visualFixture()} />
      </QueryClientProvider>
    );
    for (const id of ["goal-first-principles", "goal-knowledge-syntropy"]) {
      const row = container.querySelector(`[data-goal="${id}"]`) as HTMLElement;
      expect(row.textContent).toContain("unknown, not zero");
      expect(row.innerHTML).not.toContain("history could not be read");
      expect(row.querySelector('[aria-label^="Trend unavailable"]')).toBeNull();
    }
  });
});

describe("server rendering", () => {
  it("emits the same chart ids on every request, with no global-counter clip ids", async () => {
    const { renderToString } = await import("react-dom/server");
    const { TimeSeriesCard } = await import(
      "@/features/goals/components/TimeSeriesCard"
    );
    const { buildGoalSeries } = await import("@/features/goals/lib/series");
    const model = buildGoalSeries({
      history: history("convergence-ratio-7d", "ratio", "1h", "2026-11-05T10:00:00.000Z", [
        0.24,
        "error",
        0.25,
      ]),
      assessment: productionRatioAssessment(),
      asOf: PROD_AS_OF,
      seriesStart: null,
      title: "Seven-day convergence ratio",
      rangeTitle: "past day, hourly",
    });
    const tree = () => (
      <QueryClientProvider client={client()}>
        <GoalsBoard initialData={board()} />
        <TimeSeriesCard
          eyebrow="Seven-day convergence ratio"
          description="hourly reading"
          header={null}
          chartTitle="Seven-day convergence ratio · past day, hourly"
          ranges={[{ id: "1d", label: "1D" }]}
          range="1d"
          onRangeChange={() => {}}
          model={model}
          status="ready"
          stale={false}
          onRetry={() => {}}
          inspectHref={(id) => `/x/${id}`}
          nowIso={PROD_AS_OF}
          latestIsCurrent
          paceLabels={{ needed: null, observed: null }}
        />
      </QueryClientProvider>
    );
    const first = renderToString(tree());
    const second = renderToString(tree());
    expect(first).toContain("recharts-surface");
    expect(first).toContain("recharts-area");
    expect(first).toContain("recharts-bar");
    expect(first).not.toMatch(/recharts\d+-clip|clipPath-recharts-/);
    expect(second).toBe(first);
  });
});

describe("chart kit discipline", () => {
  it("emits raw SVG only from chart-defs.tsx", () => {
    const dir = join(process.cwd(), "src/features/goals/components");
    const tags =
      "svg|path|g|circle|rect|line|polyline|polygon|ellipse|text|defs|pattern|linearGradient|stop";
    const anyTag = new RegExp(`<\\s*(${tags})\\b`, "g");
    const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
    expect(files).toContain("chart-defs.tsx");
    for (const f of files) {
      const code = readFileSync(join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const found = [...code.matchAll(anyTag)].map((m) => m[1]);
      if (f === "chart-defs.tsx")
        expect(
          found.filter((t) => !["defs", "linearGradient", "stop", "pattern", "path"].includes(t ?? "")),
          f
        ).toEqual([]);
      else expect(found, f).toEqual([]);
    }
  });
});
