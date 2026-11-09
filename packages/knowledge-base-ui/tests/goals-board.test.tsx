// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals-board.test`
 * Purpose: Parity proof for the whole Goals capability (task.0062): a fork that renders only the package's `./goals` entry, with its own React Query client and an injected read client, gets the board at a glance (count strip, collapsible goal rows, KPI cards by display type), the open chart with its range control, quiet refresh, and the measurement-evidence view.
 * Scope: Package exports + fixture goal progress served through an injected GoalsClient or a stubbed `fetch`. No node app code, router, auth or URL state. recharts ResponsiveContainer is mocked to a fixed size so jsdom renders SVG.
 * Invariants: STATUS_NEVER_COLOR_ONLY, UNKNOWN_IS_NOT_ZERO, NO_SENTENCES_ON_CARDS, QUIET_REFRESH, GAPS_STAY_GAPS, NO_ROUTER_IMPORT (links are injected), HOST_QUERY_CLIENT.
 * Side-effects: DOM rendering in jsdom; global (stubbed fetch)
 * Links: task.0062, ../src/goals.ts, ../src/goals/goals-board.tsx
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  type GoalsProgress,
  GoalsProgressSchema,
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
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGoalsClient,
  type GoalsClient,
  GoalsBoard,
  GoalsReadError,
  GOALS_QUERY_KEY,
  type GoalsLinkProps,
  GoalsProvider,
  KpiChart,
  KpiEvidence,
  MetricEvidence,
  STATUS_META,
  useGoalsProgress,
} from "../src/goals.js";
import {
  everyStatusFixture,
  goalFixture,
  history,
  kpiFixture,
  visualFixture,
} from "./_fixtures/goals-progress.js";

// jsdom measures 0x0, so a real ResponsiveContainer renders nothing.
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

function client() {
  return new QueryClient({
    // retryDelay 0: the history queries retry once; tests need not wait 1 s.
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderBoard(
  data: GoalsProgress,
  props: Partial<React.ComponentProps<typeof GoalsBoard>> = {},
  c = client()
) {
  return {
    c,
    ...render(
      <QueryClientProvider client={c}>
        <GoalsBoard initialData={data} {...props} />
      </QueryClientProvider>
    ),
  };
}

/** A GoalsClient whose reads never settle unless a test overrides them. */
function stubClient(over: Partial<GoalsClient> = {}): GoalsClient {
  const pending = () => new Promise<never>(() => {});
  return {
    fetchGoals: pending,
    fetchHistory: pending,
    fetchMetric: pending,
    fetchObservation: pending,
    ...over,
  };
}

/** Visible words on a card: aria-only text is excluded. */
function visibleWords(el: Element): string[] {
  const clone = el.cloneNode(true) as Element;
  for (const n of clone.querySelectorAll(".sr-only")) n.remove();
  return (clone.textContent ?? "").split(/\s+/).filter(Boolean);
}

function withKpis(kpis: GoalsProgress["goals"][number]["kpis"]): GoalsProgress {
  return GoalsProgressSchema.parse({
    asOf: "2026-11-02T10:05:00.000Z",
    environment: "local",
    goals: [goalFixture("goal-x", "Goal: Ship it", kpis)],
  });
}

function productionLike(value: number, unit: string) {
  return {
    status: "on_track" as const,
    reason: null,
    value,
    unit,
    observationId: "00000000-0000-4000-8000-000000000001",
    observedAt: "2026-11-02T10:00:00.000Z",
    comparator: "gte" as const,
    target: { value: 1, unit },
    deadline: "2027-01-31T00:00:00.000Z",
    pace: { observed: null, needed: null },
  };
}

describe("GoalsBoard", () => {
  it("renders every measured KPI status as a symbol plus a word", () => {
    const { container } = renderBoard(everyStatusFixture(), {
      client: stubClient(),
    });
    for (const [status, meta] of Object.entries(STATUS_META)) {
      if (status === "not_measured") continue;
      const pill = container.querySelector(
        `[data-goal="goal-${status}"] [data-status="${status}"]`
      );
      expect(pill, status).not.toBeNull();
      expect(pill?.textContent).toContain(meta.symbol);
      expect(pill?.textContent).toContain(meta.short);
    }
    // A goal with nothing measured is a collapsed row; its cards stay hidden until opened.
    const row = container.querySelector(
      '[data-goal="goal-not_measured"]'
    ) as HTMLElement;
    const header = within(row).getAllByRole("button")[0] as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(
      document.getElementById(header.getAttribute("aria-controls") ?? "")
        ?.hidden
    ).toBe(true);
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("counts goals and KPIs once each, and every status as a count of KPIs", () => {
    const data = visualFixture();
    const { container } = renderBoard(data, { client: stubClient() });
    const kpis = data.goals.reduce((n, g) => n + g.kpis.length, 0);
    const cell = (label: string) =>
      [...container.querySelectorAll("dl > div")]
        .find((d) => d.querySelector("dt")?.textContent === label)
        ?.querySelector("dd")?.textContent;
    expect(cell("Goals")).toBe(String(data.goals.length));
    expect(cell("KPIs")).toBe(String(kpis));
    const all = data.goals.flatMap((g) => g.kpis);
    expect(cell("Behind")).toBe(
      String(all.filter((k) => k.assessment.status === "behind").length)
    );
    expect(cell("On track")).toBe(
      String(all.filter((k) => k.assessment.status === "on_track").length)
    );
  });

  it("links each goal row to its page through the injected link component and hrefs", () => {
    const data = visualFixture();
    const first = data.goals[0]!;
    const seen: GoalsLinkProps[] = [];
    const Router = (props: GoalsLinkProps) => {
      seen.push(props);
      return <a data-router="1" {...props} />;
    };
    // Default anchor and default hrefs: a node that injects nothing still links.
    const plain = renderBoard(data, { client: stubClient() });
    expect(
      plain.container.querySelector(
        `[data-goal="${first.id}"] h3 a[href="/knowledge/${first.id}"]`
      )
    ).not.toBeNull();
    cleanup();
    const { container } = renderBoard(data, {
      client: stubClient(),
      LinkComponent: Router,
      hrefs: { goal: (id) => `/goals/${id}`, help: "/help/goals" },
    });
    const row = container.querySelector(
      `[data-goal="${first.id}"]`
    ) as HTMLElement;
    const link = row.querySelector("h3 a") as HTMLAnchorElement;
    expect(link.dataset.router).toBe("1");
    expect(link.getAttribute("href")).toBe(`/goals/${first.id}`);
    expect(link.getAttribute("aria-label")).toBe(`Open ${first.title}`);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("shows one open goal with no strip or link on a goal page", () => {
    const data = visualFixture();
    const first = data.goals[0]!;
    const { container } = renderBoard(data, {
      client: stubClient(),
      goalId: first.id,
    });
    expect(container.querySelectorAll("[data-goal]")).toHaveLength(1);
    expect(container.querySelector("dl")).toBeNull();
    expect(container.querySelector("h3 a")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Goal progress" })
    ).toBeInTheDocument();
    // The first KPI is open: its chart is on screen.
    expect(container.querySelector("figure")).not.toBeNull();
    cleanup();
    renderBoard(data, { client: stubClient(), goalId: "nope" });
    expect(screen.getByText(/Not an active goal/)).toBeInTheDocument();
  });

  it("puts no sentences on a card and never prints unknown as zero", () => {
    const { container } = renderBoard(everyStatusFixture(), {
      client: stubClient(),
    });
    const cards = container.querySelectorAll("[data-kpi]");
    expect(cards.length).toBeGreaterThan(5);
    for (const card of cards)
      expect(visibleWords(card).length, card.textContent ?? "").toBeLessThanOrEqual(10);
    expect(container.textContent).not.toMatch(
      /unknown, not zero|could not be read/
    );
    // The reason is the card's accessible description and hover title, in plain words.
    const failing = container.querySelector(
      '[data-goal="goal-failing"] [data-kpi]'
    ) as HTMLElement;
    const toggle = within(failing).getByRole("button");
    expect(toggle.getAttribute("title")).toBe("The data source timed out.");
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby") ?? "")
        ?.textContent
    ).toContain("The data source timed out.");
    cleanup();
    const empty = kpiFixture(
      "m",
      "M",
      {
        ...productionLike(0, "ratio"),
        status: "failing",
        reason: "source_timeout",
        value: null,
        observationId: null,
        observedAt: null,
      },
      null
    );
    const board = renderBoard(withKpis([empty]), { client: stubClient() })
      .container;
    const card = board.querySelector("[data-kpi]") as HTMLElement;
    expect(card.querySelector(".text-3xl")?.textContent).toBe("—");
    const emptyToggle = within(card).getByRole("button");
    expect(
      document.getElementById(emptyToggle.getAttribute("aria-describedby") ?? "")
        ?.textContent
    ).toMatch(/^No reading/);
    expect(card.textContent).not.toMatch(/\b0\b(?!\.)/);
  });

  it("renders each card by the display type the read model carries", () => {
    const stars = kpiFixture(
      "github-stars",
      "GitHub stars",
      {
        ...productionLike(120, "stars"),
        comparator: "gte",
        target: { value: 200, unit: "stars" },
      },
      history("github-stars", "stars", "1d", "2026-11-03T00:00:00.000Z", [
        100,
        null,
        110,
        120,
      ])
    );
    const uptime = kpiFixture(
      "uptime",
      "Uptime",
      {
        ...productionLike(99.95, "%"),
        comparator: "gte",
        target: { value: 99.9, unit: "%" },
      },
      history("uptime", "%", "1d", "2026-11-03T00:00:00.000Z", [
        99.99,
        99.8,
        99.95,
      ])
    );
    const as = <K extends typeof stars>(
      kpi: K,
      display: "progress" | "slo" | "volume"
    ): K => ({ ...kpi, metric: kpi.metric && { ...kpi.metric, display } });
    const { container } = renderBoard(
      withKpis([
        visualFixture().goals[0]!.kpis[0]!,
        as(stars, "volume"),
        as(uptime, "slo"),
      ]),
      { client: stubClient() }
    );
    const card = (id: string) =>
      container.querySelector(`[data-kpi="${id}"]`) as HTMLElement;
    expect(card("convergence-ratio-7d").dataset.display).toBe("progress");
    expect(card("github-stars").dataset.display).toBe("volume");
    expect(card("github-stars").textContent).toContain("+20 since Oct 30");
    expect(card("uptime").dataset.display).toBe("slo");
    expect(card("uptime").textContent).toContain("99.95%");
    expect(card("uptime").textContent).toContain("budget 50%");
  });

  it("stays quiet on one failed poll, marks stale after repeats, and says signed out on 401", async () => {
    let status = 503;
    const fetchMock = vi.fn(async () => new Response("{}", { status }));
    const onSignedOut = vi.fn();
    const { c } = renderBoard(visualFixture(), {
      client: createGoalsClient({ fetch: fetchMock as typeof fetch }),
      onSignedOut,
    });
    await c.refetchQueries({ queryKey: GOALS_QUERY_KEY });
    await waitFor(() =>
      expect(c.getQueryState(GOALS_QUERY_KEY)?.status).toBe("error")
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Stale/)).toBeNull();
    expect(screen.getByText(/Updated/)).toBeTruthy();
    await c.refetchQueries({ queryKey: GOALS_QUERY_KEY });
    await c.refetchQueries({ queryKey: GOALS_QUERY_KEY });
    expect(await screen.findByText(/Stale ·/)).toBeTruthy();
    status = 401;
    await c.refetchQueries({ queryKey: GOALS_QUERY_KEY });
    const signedOut = await screen.findByText("Signed out · reload");
    fireEvent.click(signedOut);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("opens a card into a named chart that keeps gaps and links every reading", async () => {
    const data = visualFixture();
    const kpi = data.goals[0]!.kpis[0]!;
    const fetchHistory = vi.fn(async () =>
      history(
        "convergence-ratio-7d",
        "ratio",
        "1h",
        "2026-11-02T10:00:00.000Z",
        [0.5, 0.6, null, null, 0.7, 0.8]
      )
    );
    const { container } = renderBoard(data, {
      client: stubClient({ fetchHistory }),
    });
    const card = container.querySelector(
      `[data-kpi="${kpi.binding.metricId}"]`
    ) as HTMLElement;
    const toggle = within(card).getByRole("button", { name: kpi.metric!.title });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      document.getElementById(toggle.getAttribute("aria-controls") ?? "")
        ?.tagName
    ).toBe("FIGURE");
    const figure = await screen.findByRole("figure", { name: kpi.metric!.title });
    await waitFor(() =>
      expect(figure.querySelector(".recharts-area-curve")).not.toBeNull()
    );
    // Two runs of readings around the gap: the curve restarts, never bridges.
    const d = figure.querySelector(".recharts-area-curve")?.getAttribute("d") ?? "";
    expect(d.match(/M/g)?.length).toBe(2);
    const links = within(figure).getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(4);
    expect(links[0]?.getAttribute("href")).toMatch(
      /^\/knowledge\/convergence-ratio-7d\?observation=/
    );
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("changes the chart range with its control and reads one aligned window per range", async () => {
    const data = visualFixture();
    const kpi = data.goals[0]!.kpis[0]!;
    const fetchHistory = vi.fn(
      async (
        _id: string,
        w: { from: string; to: string; step: "1h" | "1d" | "1w" }
      ) =>
        history(
          "convergence-ratio-7d",
          "ratio",
          w.step,
          w.to,
          [0.5, 0.6, 0.7, 0.8]
        )
    );
    const { container } = renderBoard(data, {
      client: stubClient({ fetchHistory }),
      goalId: data.goals[0]!.id,
    });
    expect(container.querySelector("figure")).not.toBeNull();
    const group = screen.getByRole("group", { name: "Chart range" });
    const range = (label: string) =>
      within(group).getByRole("radio", { name: label });
    // A fully-shaped hourly metric opens on the week; pick the day, then the 3 months.
    await waitFor(() => expect(fetchHistory).toHaveBeenCalled());
    fireEvent.click(range("3M"));
    await waitFor(() => expect(range("3M")).toHaveAttribute("aria-checked", "true"));
    await waitFor(() =>
      expect(fetchHistory.mock.calls.some(([, w]) => w.step === "1d")).toBe(true)
    );
    const daily = fetchHistory.mock.calls.find(([, w]) => w.step === "1d")!;
    expect(daily[0]).toBe(kpi.binding.metricId);
    // 90 closed daily buckets, ending on a step boundary (the server rejects to > now).
    expect(
      (Date.parse(daily[1].to) - Date.parse(daily[1].from)) / 86_400_000
    ).toBe(90);
    // Pressing the selected range again keeps one range selected.
    fireEvent.click(range("3M"));
    expect(range("3M")).toHaveAttribute("aria-checked", "true");
  });

  it("authenticates and addresses reads through createGoalsClient alone", async () => {
    const data = visualFixture();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json(data);
    });
    const c = client();
    render(
      <QueryClientProvider client={c}>
        <GoalsBoard
          client={createGoalsClient({
            baseUrl: "https://node.example/api/v1/metrics/",
            fetch: fetchMock as unknown as typeof fetch,
            init: { headers: { Authorization: "Bearer k" }, credentials: "omit" },
          })}
          queryKeyPrefix={["node-a"]}
        />
      </QueryClientProvider>
    );
    await screen.findByRole("region", { name: "Goals" });
    await waitFor(() => expect(screen.getByText("Goals")).toBeTruthy());
    expect(calls[0]?.url).toBe("https://node.example/api/v1/metrics/goals");
    expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer k" });
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(calls[0]?.init?.credentials).toBe("omit");
    expect(c.getQueryState(["node-a", ...GOALS_QUERY_KEY])?.status).toBe(
      "success"
    );
  });

  it("emits the same markup on every server render", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = () =>
      renderToString(
        <QueryClientProvider client={client()}>
          <GoalsBoard initialData={visualFixture()} client={stubClient()} />
        </QueryClientProvider>
      );
    expect(html()).toBe(html());
  });
});

describe("useGoalsProgress", () => {
  it("shares the board's cache entry and stays off until enabled", async () => {
    const fetchGoals = vi.fn(async () => visualFixture());
    const goals = stubClient({ fetchGoals });
    function Badge({ enabled }: { enabled: boolean }) {
      const q = useGoalsProgress({ poll: false, enabled });
      return <span data-testid="n">{q.data ? q.data.goals.length : "none"}</span>;
    }
    const c = client();
    const view = (enabled: boolean) => (
      <QueryClientProvider client={c}>
        <GoalsProvider client={goals}>
          <Badge enabled={enabled} />
        </GoalsProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(view(false));
    expect(fetchGoals).not.toHaveBeenCalled();
    rerender(view(true));
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe("3"));
    expect(fetchGoals).toHaveBeenCalledTimes(1);
  });
});

describe("one host for the board and the badge", () => {
  function Badge() {
    const q = useGoalsProgress({ poll: false });
    return (
      <span data-testid="badge">{q.data ? q.data.goals.length : "none"}</span>
    );
  }

  it("shares one client, one key prefix and one cache entry under a single GoalsProvider", async () => {
    const fetchGoals = vi.fn(async () => visualFixture());
    const host = stubClient({ fetchGoals });
    const c = client();
    render(
      <QueryClientProvider client={c}>
        <GoalsProvider client={host} queryKeyPrefix={["node-a"]}>
          <Badge />
          <GoalsBoard />
        </GoalsProvider>
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("badge").textContent).toBe("3")
    );
    await screen.findByRole("region", { name: "Goals" });
    // Board and badge observe the same prefixed entry: one read, no default-key twin.
    expect(fetchGoals).toHaveBeenCalledTimes(1);
    expect(c.getQueryState(["node-a", ...GOALS_QUERY_KEY])?.status).toBe(
      "success"
    );
    expect(c.getQueryState([...GOALS_QUERY_KEY])).toBeUndefined();
  });

  it("a hook outside any provider reads the unprefixed default entry, so a host must wrap both", async () => {
    const fetchMock = vi.fn(async () => Response.json(visualFixture()));
    vi.stubGlobal("fetch", fetchMock);
    const c = client();
    render(
      <QueryClientProvider client={c}>
        <Badge />
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("badge").textContent).toBe("3")
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/metrics/goals");
    expect(c.getQueryState([...GOALS_QUERY_KEY])?.status).toBe("success");
  });
});

describe("KpiEvidence", () => {
  const binding = {
    metricId: "convergence-ratio-7d",
    comparator: "gte",
    target: { value: 0.85, unit: "ratio" },
    evaluationAt: "2026-11-09T00:00:00.000Z",
  };
  const observation = {
    id: "00000000-0000-4000-8000-000000000001",
    value: 0.82,
    unit: "ratio",
  };

  it("prints each ordered binding with target, reading, state and a pinned observation link", () => {
    const { container } = render(
      <KpiEvidence
        kpiBindings={[
          binding,
          {
            metricId: "validated-7d",
            comparator: "lte",
            target: { value: 0.85, unit: "ratio" },
          },
          { ...binding, metricId: "third", comparator: "eq" },
        ]}
        kpis={[
          { observation, viewState: "ok" },
          { observation: null, viewState: "pending" },
        ]}
      />
    );
    const section = screen.getByRole("region", {
      name: "Goal KPI measurements",
    });
    expect(
      within(section).getByRole("heading", { name: "KPI evidence" })
    ).toBeInTheDocument();
    const text = (section.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain(
      "convergence-ratio-7d · target ≥ 0.85 ratio · evaluate 2026-11-09T00:00:00.000Z"
    );
    expect(text).toContain("0.82 ratio · ok");
    expect(text).toContain("validated-7d · target ≤ 0.85 ratio");
    // No reading is Unknown with the target's unit, never 0; a missing result is unavailable.
    expect(text).toContain("Unknown ratio · pending");
    expect(text).toContain("third · target = 0.85 ratio");
    expect(text).toContain("Unknown ratio · unavailable");
    const links = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href")
    );
    expect(links).toContain("/knowledge/convergence-ratio-7d");
    expect(links).toContain(
      `/knowledge/convergence-ratio-7d?observation=${observation.id}#observation-${observation.id}`
    );
    expect(links).toHaveLength(4);
  });

  it("takes its links from the injected hrefs and link component", () => {
    const Router = (props: GoalsLinkProps) => <a data-router="1" {...props} />;
    const { container } = render(
      <GoalsProvider
        LinkComponent={Router}
        hrefs={{
          metric: (id) => `/m/${id}`,
          observation: (id, o) => `/o/${id}/${o}`,
        }}
      >
        <KpiEvidence
          kpiBindings={[binding]}
          kpis={[{ observation, viewState: "ok" }]}
        />
      </GoalsProvider>
    );
    const links = [...container.querySelectorAll("a[data-router]")].map((a) =>
      a.getAttribute("href")
    );
    expect(links).toEqual([
      "/m/convergence-ratio-7d",
      `/o/convergence-ratio-7d/${observation.id}#observation-${observation.id}`,
    ]);
  });

  it("renders nothing for no bindings or an invalid binding list", () => {
    expect(render(<KpiEvidence kpiBindings={[]} />).container.firstChild).toBeNull();
    cleanup();
    expect(
      render(<KpiEvidence kpiBindings={[{ metricId: 7 }]} />).container
        .firstChild
    ).toBeNull();
    cleanup();
    expect(
      render(<KpiEvidence kpiBindings={undefined} />).container.firstChild
    ).toBeNull();
  });
});

describe("KpiChart", () => {
  it("renders alone from the host defaults with its own named figure", async () => {
    const kpi = visualFixture().goals[0]!.kpis[0]!;
    const client_ = stubClient({
      fetchHistory: async () =>
        history("convergence-ratio-7d", "ratio", "1d", "2026-11-02T00:00:00.000Z", [
          0.5, 0.6, 0.7, 0.8,
        ]),
    });
    render(
      <QueryClientProvider client={client()}>
        <GoalsProvider client={client_}>
          <KpiChart kpi={kpi} nowIso="2026-11-02T10:05:00.000Z" />
        </GoalsProvider>
      </QueryClientProvider>
    );
    expect(
      await screen.findByRole("figure", { name: kpi.metric!.title })
    ).toBeInTheDocument();
  });
});

describe("GoalsReadError", () => {
  it("carries the HTTP status and the resource, never a message to parse", () => {
    const e = new GoalsReadError("goals", 401);
    expect(e.status).toBe(401);
    expect(e.resource).toBe("goals");
    expect(e.message).toBe("goals_read_failed:401");
  });
});

describe("MetricEvidence", () => {
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
  const definition = {
    id: "work",
    title: "Work",
    revision: "1",
    spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 60 },
  };

  it("pins the linked immutable reading ahead of newer rolling readings", async () => {
    const pinned = reading(1, 5);
    const later = reading(2, 20);
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
        <MetricEvidence id="work" observationId={pinned.id} />
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

  it("shows the newest readings with no link, and says so when evidence is unavailable", async () => {
    const later = reading(2, 20);
    const ok = vi.fn(async () =>
      Response.json({
        definition,
        latestAttempt: later,
        lastGood: later,
        viewState: "ok",
        history: [later],
      })
    );
    vi.stubGlobal("fetch", ok);
    const { container } = render(
      <QueryClientProvider client={client()}>
        <MetricEvidence id="work" />
      </QueryClientProvider>
    );
    await screen.findByText(/Measurement history/);
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(screen.queryByText(/Linked immutable evidence/)).toBeNull();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    render(
      <QueryClientProvider client={client()}>
        <MetricEvidence id="work" />
      </QueryClientProvider>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Measurement evidence is unavailable."
    );
  });
});
