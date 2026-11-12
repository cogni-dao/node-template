// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/metrics-page`
 * Purpose: Prove this node's mounts of the published Goals capability: the Metrics page (story.0039) renders the package's Metrics view; `/knowledge?mode=goals` redirects to it and the Knowledge tabs no longer carry Goals; the entry page hands `?observation=` to the evidence view (task.0062). The board, chart and read client themselves are proven in packages/knowledge-base-ui.
 * Scope: React Query plus the browser fetch boundary, rendering the real `@cogni/knowledge-base-ui/goals` entry. No live network.
 * Invariants: OLD_LINKS_KEEP_WORKING (redirect before any read), WAI_ARIA_TABS, URL_DRIVEN_MODE.
 * Side-effects: global (stubbed fetch)
 * Links: app/src/app/(app)/metrics/view.tsx, app/src/app/(app)/knowledge/page.tsx, app/src/app/(app)/knowledge/_components/GoalsMount.tsx
 * @vitest-environment jsdom
 * @internal
 */

import { GoalsProgressSchema } from "@cogni-dao/metrics/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeMetricEvidence } from "@/app/(app)/knowledge/_components/GoalsMount";
import { KnowledgeDashboardView } from "@/app/(app)/knowledge/view";
import { MetricsView } from "@/app/(app)/metrics/view";

const loaders = vi.hoisted(() => ({ loadKnowledgeBrowse: vi.fn() }));
const navigation = vi.hoisted(() => ({
  mode: "browse",
  observation: null as string | null,
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () =>
    new URLSearchParams({
      mode: navigation.mode,
      ...(navigation.observation
        ? { observation: navigation.observation }
        : {}),
    }),
}));
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
vi.mock("@/app/(app)/knowledge/_components/ContributionDetail", () => ({
  ContributionDetail: () => null,
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
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigation.push.mockReset();
  navigation.mode = "browse";
  navigation.observation = null;
});

/** One goal whose only KPI is behind pace, plus one metric that serves no KPI. */
function oneBehindGoal() {
  return GoalsProgressSchema.parse({
    asOf: "2026-11-02T10:05:00.000Z",
    environment: "local",
    orphans: [],
    unbound: [
      {
        metric: { id: "loose", title: "Loose count", calculatorId: "work.count@1" },
        assessment: null,
        latest: {
          viewState: "ok",
          value: 3,
          unit: "items",
          observedAt: "2026-11-02T10:00:00.000Z",
          reason: null,
        },
      },
    ],
    goals: [
      {
        id: "goal-x",
        title: "Goal: Ship it",
        evaluateAt: "2027-01-31T00:00:00.000Z",
        configurationError: false,
        kpis: [
          {
            binding: {
              metricId: "m",
              comparator: "gte",
              target: { value: 1, unit: "ratio" },
            },
            metric: {
              id: "m",
              title: "Ratio",
              calculatorId: "work.convergence@1",
              cadenceSeconds: 3600,
              maxAgeSeconds: 7200,
            },
            assessment: {
              status: "behind",
              reason: null,
              value: 0.8,
              unit: "ratio",
              observationId: "00000000-0000-4000-8000-000000000001",
              observedAt: "2026-11-02T10:00:00.000Z",
              comparator: "gte",
              target: { value: 1, unit: "ratio" },
              deadline: "2027-01-31T00:00:00.000Z",
              pace: { observed: 0.01, needed: 0.014 },
            },
            trend: null,
          },
        ],
        hypotheses: [],
        moreHypotheses: false,
        hypothesesUnavailable: false,
      },
    ],
  });
}

describe("Knowledge tabs after the Goals tab moved to /metrics", () => {
  it("has no Goals tab, no goal read and no Goals badge, and treats ?mode=goals as Browse", async () => {
    navigation.mode = "goals";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/v1/knowledge/contributions"))
        return Response.json({ contributions: [] });
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={client()}>
        <KnowledgeDashboardView
          initialList={{ items: [], domains: [] }}
          initialDomains={{ domains: [] }}
        />
      </QueryClientProvider>
    );
    const tablist = screen.getByRole("tablist", { name: "Knowledge views" });
    expect(within(tablist).getAllByRole("tab").map((t) => t.id)).toEqual([
      "knowledge-tab-browse",
      "knowledge-tab-graph",
      "knowledge-tab-chains",
      "knowledge-tab-domains",
      "knowledge-tab-inbox",
    ]);
    expect(
      within(tablist).getByRole("tab", { name: /^Browse/ }).getAttribute("aria-selected")
    ).toBe("true");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url.startsWith("/api/v1/knowledge/browse?"))
      ).toBe(true)
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
      "/api/v1/metrics/goals"
    );
  });
});

describe("/knowledge?mode=goals redirect", () => {
  it("sends a signed-in visitor to /metrics before any goal or knowledge read, and leaves other modes alone", async () => {
    vi.doMock("@/lib/auth/server", () => ({
      getServerSessionUser: async () => ({ id: "u" }),
    }));
    vi.doMock("@/bootstrap/container", () => ({
      getContainer: () => ({ knowledgeStorePort: {} }),
    }));
    vi.doMock("@/app/(app)/knowledge/_server/loaders", () => ({
      ...loaders,
      loadDomains: vi.fn(),
      loadKnowledgeListCached: vi.fn(),
    }));
    vi.doMock("@/app/(app)/knowledge/view", () => ({
      KnowledgeDashboardView: () => null,
    }));
    const { default: KnowledgePage } = await import("@/app/(app)/knowledge/page");
    await expect(
      KnowledgePage({ searchParams: Promise.resolve({ mode: "goals" }) })
    ).rejects.toThrow("REDIRECT:/metrics");
    expect(loaders.loadKnowledgeBrowse).not.toHaveBeenCalled();
    await expect(
      KnowledgePage({ searchParams: Promise.resolve({ mode: "inbox" }) })
    ).resolves.toBeTruthy();
  });
});

describe("Metrics page", () => {
  it("renders the package's Metrics view under the page title, from the SSR seed, with no extra read", () => {
    const fetchMock = vi.fn(async () => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={client()}>
        <MetricsView initialData={oneBehindGoal()} />
      </QueryClientProvider>
    );
    expect(screen.getByRole("heading", { level: 1, name: "Metrics" })).toBeTruthy();
    const region = screen.getByRole("region", { name: "Metrics" });
    expect(within(region).getByText("Goal: Ship it")).toBeTruthy();
    expect(within(region).getByText("Not serving a KPI")).toBeTruthy();
    expect(within(region).getByText("Loose count")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Knowledge metric evidence mount", () => {
  it("hands the page's ?observation= to the published evidence view", async () => {
    const id = "00000000-0000-4000-8000-000000000009";
    navigation.observation = id;
    const definition = {
      id: "work",
      title: "Work",
      revision: "1",
      spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 60 },
    };
    const reading = {
      id,
      metricId: "work",
      definitionRevision: "1",
      definitionHash: "hash1",
      calculatorVersion: "work.count@1",
      paramsHash: "params1",
      node: "test",
      environment: "test",
      dataScope: "test",
      window: { start: "2026-11-02T00:00:00Z", end: "2026-11-02T01:00:00Z" },
      sourceWatermarks: [{ source: "work", asOf: "2026-11-02T00:00:00Z" }],
      observedAt: "2026-11-02T01:00:00Z",
      status: "ok",
      value: 5,
      unit: "items",
      reason: null,
      evidenceRefs: ["node:work"],
    };
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/v1/metrics/work"
        ? Response.json({
            definition,
            latestAttempt: reading,
            lastGood: reading,
            viewState: "ok",
            history: [reading],
          })
        : url === `/api/v1/metrics/work/observations/${id}`
          ? Response.json({ definition, observation: reading })
          : new Response("{}", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={client()}>
        <KnowledgeMetricEvidence id="work" />
      </QueryClientProvider>
    );
    await screen.findByText(/Linked immutable evidence/);
    expect(fetchMock.mock.calls.map(([u]) => u).filter((u) => !u.includes("/history?"))).toEqual([
      "/api/v1/metrics/work",
      `/api/v1/metrics/work/observations/${id}`,
    ]);
  });
});
