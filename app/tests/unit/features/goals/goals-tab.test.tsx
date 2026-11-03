// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/goals/goals-tab`
 * Purpose: Prove the Goals tab shows every KPI status as a symbol plus a word,
 *   says "unknown, not zero" for missing readings, keeps stale data labeled
 *   "not current" after a failed refresh, and is a URL-addressable Knowledge tab.
 * Scope: React Query plus the browser fetch boundary. No live network.
 * Invariants: STATUS_NEVER_COLOR_ONLY, UNKNOWN_IS_NOT_ZERO, ONE_ALERT_ON_FAILURE,
 *   WAI_ARIA_TABS, URL_DRIVEN_MODE.
 * Side-effects: global (stubbed fetch)
 * Links: app/src/features/goals/components/GoalsBoard.tsx, app/src/app/(app)/knowledge/view.tsx
 * @vitest-environment jsdom
 * @internal
 */

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
import {
  everyStatusFixture,
  visualFixture,
} from "@tests/_fixtures/goals/progress";
import { KnowledgeDashboardView } from "@/app/(app)/knowledge/view";
import { GoalsBoard } from "@/features/goals";
import { STATUS_META } from "@/features/goals/lib/presentation";

const navigation = vi.hoisted(() => ({
  mode: "browse",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams({ mode: navigation.mode }),
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
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigation.replace.mockReset();
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
    // Every chart states its values in words.
    const charts = container.querySelectorAll('svg:not([aria-hidden="true"])');
    expect(charts.length).toBeGreaterThan(0);
    for (const svg of charts) {
      expect(svg.getAttribute("role")).toBe("img");
      expect(svg.getAttribute("aria-label")).toMatch(/target/);
    }
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
    expect(
      within(detail).getByRole("button", { name: "30d", pressed: true })
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
    render(
      <QueryClientProvider client={client()}>
        <KnowledgeDashboardView
          initialList={{ items: [], domains: [] }}
          initialDomains={{ domains: [] }}
        />
      </QueryClientProvider>
    );
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
    expect(navigation.replace).toHaveBeenCalledWith("/knowledge?mode=goals", {
      scroll: false,
    });
    expect(goals.getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(goals.id);
    expect(
      within(panel).getByRole("region", { name: "Goals" })
    ).toBeTruthy();

    // Arrow keys move focus along the tablist (manual activation).
    goals.focus();
    fireEvent.keyDown(goals, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toMatch(/^Inbox/);

    fireEvent.click(within(tablist).getByRole("tab", { name: "Browse" }));
    expect(navigation.replace).toHaveBeenLastCalledWith("/knowledge", {
      scroll: false,
    });
  });
});
