// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-selection-direct-links`
 * Purpose: Prove bounded hydration, explicit search windows, replacement focus and exact-ID selection.
 * Scope: Real grid context/headers, node controllers and schemas; row/WebGL drawing and transport are stubbed.
 * Invariants: NO_HIDDEN_READS, FIVE_CURRENT_LINKS, EXPLICIT_CONTINUATION, STALE_INTENT_IGNORED.
 * Side-effects: Stubbed browser fetch; no live services or database.
 * Links: https://github.com/cogni-dao/cogni/issues/2846
 * @vitest-environment jsdom
 * @internal
 */

import type { KnowledgeRow } from "@cogni/node-contracts";
import { DataGrid } from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  type Table,
  useReactTable,
} from "@tanstack/react-table";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { browseKey } from "@/app/(app)/knowledge/_api/fetchBrowse";
import { BoundedBrowse } from "@/app/(app)/knowledge/_components/BoundedBrowse";
import { knowledgeColumns } from "@/app/(app)/knowledge/_components/columns";
import { KnowledgeSelection } from "@/app/(app)/knowledge/_components/KnowledgeSelection";
import {
  focusGeometry,
  useGraphFocus,
} from "@/app/(app)/knowledge/_components/useGraphFocus";
import {
  loadKnowledgeBrowse,
  loadKnowledgeOverview,
} from "@/app/(app)/knowledge/_server/loaders";
import KnowledgePage from "@/app/(app)/knowledge/page";
import { KnowledgeDashboardView } from "@/app/(app)/knowledge/view";
import { GET as browseRoute } from "@/app/api/v1/knowledge/browse/route";
import { GET as overviewRoute } from "@/app/api/v1/knowledge/overview/route";

vi.mock(
  "@cogni/node-contracts",
  async () => import("../../../../packages/knowledge-store/src/contracts")
);
vi.mock("@/app/_facades/read-envelopes.server", () => ({
  toHttpKnowledgeRow: vi.fn(),
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
const ssr = vi.hoisted(() => ({ port: undefined as unknown }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ knowledgeStorePort: ssr.port }),
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => ({ id: "fixture" }),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/app/_facades/metrics.server", () => ({
  loadGoalsProgress: () => {
    throw new Error("Hidden Goals read");
  },
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
const navigation = vi.hoisted(() => ({ mode: "browse" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ mode: navigation.mode }),
}));

// Only the grid and WebGL presentation are replaced. Their real parent
// selection callbacks, detail fields and released relation UI remain mounted.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    ({
      graphData,
      onNodeClick,
    }: {
      graphData: {
        nodes: Array<{ id: string; title: string; isHub: boolean }>;
      };
      onNodeClick: (node: { id: string; isHub: boolean }) => void;
    }) => (
      <div>
        {graphData.nodes
          .filter((node) => !node.isHub)
          .map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => onNodeClick(node)}
            >
              Select graph {node.title}
            </button>
          ))}
      </div>
    ),
}));

vi.mock(
  "@cogni/node-ui-kit/reui/data-grid/data-grid",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@cogni/node-ui-kit/reui/data-grid/data-grid")
      >();
    return {
      ...actual,
      DataGrid: (props: ComponentProps<typeof actual.DataGrid>) => {
        const table = props.table as Table<KnowledgeRow>;
        return (
          <actual.DataGrid {...props}>
            {table.getHeaderGroups().map((group) => (
              <div key={group.id}>
                {group.headers.map((header) => (
                  <div key={header.id}>
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                  </div>
                ))}
              </div>
            ))}
            {table.getRowModel().rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => props.onRowClick?.(row.original)}
              >
                Select row {row.original.title}
              </button>
            ))}
          </actual.DataGrid>
        );
      },
    };
  }
);
vi.mock(
  "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility",
  () => ({
    DataGridColumnVisibility: () => null,
  })
);
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-pagination", () => ({
  DataGridPagination: () => null,
}));
vi.mock("@cogni/node-ui-kit/header-filter", () => ({
  HeaderFilter: () => null,
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-table", () => ({
  DataGridTable: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/AddDomainSheet", () => ({
  AddDomainSheet: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/ConfidenceBar", () => ({
  ConfidenceBar: () => null,
}));
// This suite owns atom selection; automatic goal polling has its own evidence.
vi.mock("@/features/goals", () => ({
  GoalsBoard: () => null,
  GOALS_QUERY_KEY: ["goals", "progress"],
  fetchGoalsProgress: () => new Promise(() => {}),
  attentionCount: () => 0,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, disabled, onClick }: ComponentProps<"button">) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const selected = {
  id: "node-template-selected-decision",
  domain: "meta",
  entityId: null,
  title: "node-template selected decision",
  content: "The already-loaded node-template entry body",
  useWhen: null,
  entryType: "decision",
  confidencePct: 80,
  sourceType: "human",
  sourceRef: null,
  tags: null,
  createdAt: null,
  evaluateAt: null,
  resolutionStrategy: null,
} satisfies KnowledgeRow;

function relation(index: number) {
  return {
    id: `direct-${index}`,
    direction: "out",
    citationType: "supports",
    source: {
      id: selected.id,
      kind: "knowledge",
      title: selected.title,
      href: `/knowledge/${selected.id}`,
    },
    target: {
      id: `neighbor-${index}`,
      kind: "knowledge",
      title: `Direct relation ${index}`,
      href: `/knowledge/neighbor-${index}`,
    },
    context: null,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page = { items: [selected], nextCursor: null, scannedRows: 1 };
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

it.each(["browse", "chains", "graph"])(
  "%s preserves tab-intent reads and direct-relation selection",
  async (mode) => {
    navigation.mode = mode;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `/api/v1/knowledge/${selected.id}`)
        return Response.json(selected);
      if (url.startsWith(`/api/v1/citations/${selected.id}`))
        return Response.json({
          links: Array.from({ length: 5 }, (_, i) => relation(i)),
          nextCursor: "next",
        });
      throw new Error(`Unexpected read ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mount(
      <KnowledgeDashboardView
        initialBrowse={page}
        initialOverview={page}
        initialList={
          mode === "chains"
            ? { items: [selected], domains: [selected.domain] }
            : undefined
        }
      />
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Select ${mode === "graph" ? "graph" : "row"} ${selected.title}`,
      })
    );
    await screen.findByText(selected.content);
    await screen.findByRole("link", { name: "supports Direct relation 4" });
    expect(
      fetchMock.mock.calls.every(
        ([url]) =>
          url === `/api/v1/knowledge/${selected.id}` ||
          url.startsWith(`/api/v1/citations/${selected.id}`)
      )
    ).toBe(true);
    // Detail's append controller remains separate from replacement graph geometry.
    expect(screen.getByRole("button", { name: "More links" })).toBeTruthy();
  }
);

it("SSR reads only the chosen bounded projection and round-trips the wire page", async () => {
  const emptyPage = { items: [], nextCursor: null, scannedRows: 0 };
  const browseKnowledge = vi.fn(async () => emptyPage);
  const overviewKnowledge = vi.fn(async () => emptyPage);
  const port = new Proxy(
    { browseKnowledge, overviewKnowledge },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        throw new Error(`Unexpected initial read ${String(key)}`);
      },
    }
  );
  expect(await loadKnowledgeBrowse(port as never)).toEqual(emptyPage);
  expect(browseKnowledge).toHaveBeenCalledTimes(1);
  expect(overviewKnowledge).not.toHaveBeenCalled();
  expect(await loadKnowledgeOverview(port as never)).toEqual(emptyPage);
  expect(overviewKnowledge).toHaveBeenCalledTimes(1);
  ssr.port = port;
  const browse = await KnowledgePage({ searchParams: Promise.resolve({}) });
  expect(browse.props.initialBrowse).toEqual(emptyPage);
  expect(browse.props.initialOverview).toBeUndefined();
  const graph = await KnowledgePage({
    searchParams: Promise.resolve({ mode: "graph" }),
  });
  expect(graph.props.initialOverview).toEqual(emptyPage);
  expect(graph.props.initialList).toBeUndefined();
  expect(browseKnowledge).toHaveBeenCalledTimes(2);
  expect(overviewKnowledge).toHaveBeenCalledTimes(2);
});

it("empty search windows require intent, keep the retry cursor, and retain off-page filters", async () => {
  const reads: URL[] = [];
  let failed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const parsed = new URL(url, "https://node.test");
      reads.push(parsed);
      if (parsed.searchParams.get("domains") === "missing")
        return Response.json({ items: [], nextCursor: null, scannedRows: 0 });
      if (parsed.searchParams.get("domains") === "off-page")
        return Response.json(page);
      if (parsed.searchParams.get("search")) {
        if (parsed.searchParams.get("cursor") === "after-20") {
          if (!failed) {
            failed = true;
            return Response.json({ error: "deadline" }, { status: 503 });
          }
          return Response.json(page);
        }
        return Response.json({
          items: [],
          nextCursor: "after-20",
          scannedRows: 20,
        });
      }
      return Response.json(page);
    })
  );
  mount(<BoundedBrowse initialData={page} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search knowledge" }), {
    target: { value: "body" },
  });
  await screen.findByText(/20 candidates searched/);
  expect(reads).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Continue search" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry window" }));
  await screen.findByRole("button", { name: `Select row ${selected.title}` });
  expect(reads.slice(1).map((url) => url.searchParams.get("cursor"))).toEqual([
    "after-20",
    "after-20",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Domain", exact: true }));
  const domain = await screen.findByRole("textbox", { name: "Exact Domain" });
  fireEvent.change(domain, { target: { value: "missing" } });
  fireEvent.submit(required(domain.closest("form")));
  await waitFor(() =>
    expect(reads.at(-1)?.searchParams.get("domains")).toBe("missing")
  );
  expect(screen.getByLabelText("missing")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear Domain" }));
  fireEvent.change(domain, { target: { value: "off-page" } });
  fireEvent.submit(required(domain.closest("form")));
  await user.keyboard("{Escape}");
  await screen.findByRole("button", { name: `Select row ${selected.title}` });
  expect(reads.at(-1)?.searchParams.get("domains")).toBe("off-page");
});

it("focus replaces 5/5/2 geometry, preserves typed edges and Work links, and retries failed expansion", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("cursor=next-1")) {
        if (fail) {
          fail = false;
          return Response.json({}, { status: 503 });
        }
        return Response.json({
          links: Array.from({ length: 5 }, (_, i) => relation(i + 5)),
          nextCursor: "next-2",
        });
      }
      if (url.includes("cursor=next-2"))
        return Response.json({
          links: [
            {
              ...relation(10),
              direction: "in",
              source: relation(10).target,
              target: relation(10).source,
            },
            {
              ...relation(11),
              target: {
                ...relation(11).target,
                kind: "work",
                href: "/work/items/task.1234",
              },
            },
          ],
          nextCursor: null,
        });
      return Response.json({
        links: Array.from({ length: 5 }, (_, i) => relation(i)),
        nextCursor: "next-1",
      });
    })
  );
  const { result } = renderHook(() => useGraphFocus(selected.id));
  await waitFor(() => expect(result.current.links).toHaveLength(5));
  const overview = Array.from({ length: 20 }, (_, i) => ({
    ...selected,
    id: `overview-${i}`,
  }));
  expect(focusGeometry(overview, selected, result.current).nodes).toHaveLength(
    26
  );
  act(() => result.current.more());
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.links[0]?.id).toBe("direct-0");
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.links[0]?.id).toBe("direct-5"));
  expect(focusGeometry(overview, selected, result.current).links).toHaveLength(
    5
  );
  expect(
    focusGeometry(overview, selected, result.current).nodes.some(
      (node) => node.id === "neighbor-0"
    )
  ).toBe(false);
  act(() => result.current.more());
  await waitFor(() => expect(result.current.links).toHaveLength(2));
  const geometry = focusGeometry(overview, selected, result.current);
  expect(geometry.links[0]).toMatchObject({
    id: "direct-10",
    source: "neighbor-10",
    target: selected.id,
    direction: "in",
    citationType: "supports",
  });
  expect(geometry.nodes.length).toBeLessThanOrEqual(26);
  expect(geometry.nodes.some((node) => node.id === "neighbor-11")).toBe(false);
  expect(result.current.links[1]?.target.href).toBe("/work/items/task.1234");
});

it("stale focus and off-list detail responses cannot replace newer selection", async () => {
  const delayed = new Map<string, (value: Response) => void>();
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, options: RequestInit) => {
      signals.push(options.signal as AbortSignal);
      return new Promise<Response>((resolve) => delayed.set(url, resolve));
    })
  );
  const focus = renderHook(({ id }) => useGraphFocus(id), {
    initialProps: { id: "old" },
  });
  focus.rerender({ id: "new" });
  await act(async () =>
    delayed.get("/api/v1/citations/new")?.(
      Response.json({ links: [relation(8)], nextCursor: null })
    )
  );
  await act(async () =>
    delayed.get("/api/v1/citations/old")?.(
      Response.json({ links: [relation(0)], nextCursor: null })
    )
  );
  expect(focus.result.current.links[0]?.id).toBe("direct-8");
  expect(signals[0]?.aborted).toBe(true);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const ui = render(
    <QueryClientProvider client={client}>
      <KnowledgeSelection id="off-list-old" onClose={() => {}} />
    </QueryClientProvider>
  );
  ui.rerender(
    <QueryClientProvider client={client}>
      <KnowledgeSelection id="off-list-new" onClose={() => {}} />
    </QueryClientProvider>
  );
  await act(async () =>
    delayed.get("/api/v1/knowledge/off-list-new")?.(
      Response.json({
        ...selected,
        id: "off-list-new",
        content: "New off-list body",
      })
    )
  );
  await screen.findByText("New off-list body");
  await act(async () =>
    delayed.get("/api/v1/knowledge/off-list-old")?.(
      Response.json({
        ...selected,
        id: "off-list-old",
        content: "Stale old body",
      })
    )
  );
  expect(screen.queryByText("Stale old body")).toBeNull();
});

it("thin routes reject malformed and cross-query cursors and preserve repeated exact filters", async () => {
  const browseKnowledge = vi.fn(async (query: { cursor?: string }) => {
    if (query.cursor) throw new Error("Browse cursor does not match query");
    return { items: [], nextCursor: null, scannedRows: 0 };
  });
  ssr.port = { browseKnowledge };
  type Handler = (
    ctx: unknown,
    request: Request,
    user: unknown
  ) => Promise<Response>;
  const invoke = (handler: unknown, query: string) =>
    (handler as Handler)(
      {},
      new Request(`https://node.test/api/v1/knowledge/browse?${query}`),
      { id: "fixture" }
    );
  expect((await invoke(browseRoute, "sort=content")).status).toBe(400);
  expect((await invoke(browseRoute, "cursor=cross-query")).status).toBe(400);
  expect((await invoke(overviewRoute, "search=body")).status).toBe(400);
  expect(
    (await invoke(browseRoute, "domains=late&domains=off-page")).status
  ).toBe(200);
  expect(browseKnowledge).toHaveBeenLastCalledWith(
    expect.objectContaining({ domains: ["late", "off-page"] })
  );
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing required fixture value");
  return value;
}

it("keeps the real Type filter valid at capacity and frees slots on deselection", async () => {
  const reads: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      reads.push(new URL(url, "https://node.test"));
      return Response.json({ items: [], nextCursor: null, scannedRows: 0 });
    }),
  );
  const user = userEvent.setup();
  mount(
    <BoundedBrowse
      initialData={{ items: [], nextCursor: null, scannedRows: 0 }}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search knowledge" }), {
    target: { value: "body" },
  });
  await user.click(screen.getByRole("button", { name: "Domain", exact: true }));
  const domain = await screen.findByRole("textbox", { name: "Exact Domain" });
  fireEvent.change(domain, { target: { value: "off-page" } });
  fireEvent.submit(required(domain.closest("form")));
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Type", exact: true }));
  const input = await screen.findByRole("textbox", { name: "Exact Type" });
  for (let i = 0; i < 50; i++) {
    fireEvent.change(input, { target: { value: `custom-${i}` } });
    fireEvent.submit(required(input.closest("form")));
  }
  const canonical = screen.getByRole("checkbox", {
    name: "guide",
  }) as HTMLInputElement;
  expect(canonical.disabled).toBe(true);
  expect(screen.getByText(/Maximum 50 values selected/)).toBeTruthy();
  await user.click(canonical);
  expect(canonical.checked).toBe(false);
  await user.click(screen.getByRole("checkbox", { name: "custom-0" }));
  expect(canonical.disabled).toBe(false);
  await user.click(canonical);
  expect(canonical.checked).toBe(true);
  await waitFor(() => {
    const params = required(reads.at(-1)).searchParams;
    expect(params.getAll("entryTypes")).toHaveLength(50);
    expect(params.getAll("entryTypes")).toContain("guide");
    expect(params.getAll("entryTypes")).not.toContain("custom-0");
    expect(params.getAll("domains")).toEqual(["off-page"]);
    expect(params.get("search")).toBe("body");
  });
});

it.each([false, true])(
  "real empty-window headers preserve global controls (search=%s)",
  async (searching) => {
    const reads: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        reads.push(new URL(url, "https://node.test"));
        return Response.json({
          items: [],
          nextCursor: searching ? "after-20" : null,
          scannedRows: searching ? 20 : 0,
        });
      })
    );
    const user = userEvent.setup();
    mount(
      <BoundedBrowse
        initialData={{ items: [], nextCursor: null, scannedRows: 0 }}
      />
    );
    if (searching) {
      fireEvent.change(
        screen.getByRole("textbox", { name: "Search knowledge" }),
        { target: { value: "body" } }
      );
      await screen.findByText(/20 candidates searched/);
      await user.click(screen.getByRole("button", { name: "Continue search" }));
      await waitFor(() =>
        expect(reads.at(-1)?.searchParams.get("cursor")).toBe("after-20")
      );
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Domain", exact: true })
            .hasAttribute("disabled")
        ).toBe(false)
      );
    }
    async function open(label: string) {
      const trigger = screen.getByRole("button", { name: label, exact: true });
      expect(trigger.hasAttribute("disabled")).toBe(false);
      await user.click(trigger);
      return screen.findByRole("textbox", { name: `Exact ${label}` });
    }
    async function add(label: string, value: string) {
      const input = await open(label);
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(required(input.closest("form")));
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: label, exact: true })
            .hasAttribute("disabled")
        ).toBe(false)
      );
    }
    await add("Type", "guide");
    await add("Source", "human");
    await add("Domain", "missing");
    await open("Domain");
    await user.click(screen.getByRole("checkbox", { name: "missing" }));
    const domain = screen.getByRole("textbox", { name: "Exact Domain" });
    fireEvent.change(domain, { target: { value: "off-page" } });
    fireEvent.submit(required(domain.closest("form")));
    await waitFor(() =>
      expect(reads.at(-1)?.searchParams.getAll("domains")).toEqual(["off-page"])
    );
    await user.click(screen.getByRole("button", { name: "Clear Domain" }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(reads.at(-1)?.searchParams.getAll("domains")).toEqual([])
    );
    for (const [label, sort] of [
      ["Domain", "domain"],
      ["Type", "entryType"],
      ["Source", "sourceType"],
    ]) {
      await open(required(label));
      await user.click(
        screen.getByRole("menuitem", { name: "Asc", exact: true })
      );
      await waitFor(() =>
        expect(reads.at(-1)?.searchParams.get("sort")).toBe(sort)
      );
      expect(reads.at(-1)?.searchParams.get("direction")).toBe("asc");
    }
    for (const label of ["Confidence", "Created"]) {
      const header = screen.getByRole("button", { name: label, exact: true });
      expect(header.hasAttribute("disabled")).toBe(false);
      await user.click(header);
      await waitFor(() =>
        expect(reads.at(-1)?.searchParams.get("sort")).toBe(
          label === "Created" ? "createdAt" : "confidencePct"
        )
      );
      await waitFor(() => expect(header.hasAttribute("disabled")).toBe(false));
    }
    const last = required(reads.at(-1)).searchParams;
    expect(last.getAll("entryTypes")).toEqual(["guide"]);
    expect(last.getAll("sourceTypes")).toEqual(["human"]);
    expect(last.get("search")).toBe(searching ? "body" : null);
    expect(last.get("cursor")).toBeNull();
  }
);

it("stale body windows ignore focus/reconnect, remount awaits intent, and Continue/Retry/Restart work", async () => {
  const reads: URL[] = [];
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const parsed = new URL(url, "https://node.test");
      reads.push(parsed);
      if (parsed.searchParams.get("cursor") && fail) {
        fail = false;
        return Response.json({}, { status: 503 });
      }
      return Response.json({
        items: [],
        nextCursor: "after-20",
        scannedRows: 20,
      });
    })
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = () => (
    <QueryClientProvider client={client}>
      <BoundedBrowse initialData={page} />
    </QueryClientProvider>
  );
  let mounted = render(ui());
  const search = () =>
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search knowledge" }),
      { target: { value: "body" } }
    );
  search();
  await screen.findByText(/20 candidates searched/);
  const key = browseKey({ search: "body" });
  client.setQueryData(key, client.getQueryData(key), {
    updatedAt: Date.now() - 60_000,
  });
  async function lifecycle() {
    await act(async () => {
      focusManager.setFocused(false);
      onlineManager.setOnline(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  try {
    await lifecycle();
    expect(reads).toHaveLength(1);
    mounted.unmount();
    mounted = render(ui());
    await act(async () => {});
    expect(reads).toHaveLength(1);
    // Remount resets the local text. Re-entering it is a new explicit search.
    search();
    await screen.findByText(/20 candidates searched/);
    await lifecycle();
    expect(reads).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Continue search" }));
    await screen.findByRole("alert");
    await lifecycle();
    expect(reads).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Retry window" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(reads.map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      null,
      "after-20",
      "after-20",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(reads).toHaveLength(5));
    expect(reads.at(-1)?.searchParams.get("cursor")).toBeNull();
    expect(
      reads.every((url) => url.searchParams.get("search") === "body")
    ).toBe(true);
  } finally {
    mounted.unmount();
    client.clear();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  }
});

it("legacy columns retain disabled empty headers at the real grid boundary", () => {
  function LegacyEmpty() {
    const table = useReactTable({
      data: [],
      columns: knowledgeColumns,
      getCoreRowModel: getCoreRowModel(),
    });
    return <DataGrid table={table} recordCount={0} />;
  }
  render(<LegacyEmpty />);
  for (const label of ["Domain", "Type", "Source", "Confidence", "Created"])
    expect(
      screen
        .getByRole("button", { name: label, exact: true })
        .hasAttribute("disabled")
    ).toBe(true);
});
