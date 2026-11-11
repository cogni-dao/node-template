// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-selection-direct-links`
 * Purpose: Prove node-template composes the package Browse and Graph over its own transport: bounded SSR hydration, tab-intent reads, submit-only search through the node fetcher, the whole-corpus graph with exact counts, graph-route ETag/304 revalidation, exact-ID selection and thin routes.
 * Scope: Real package Browse/Graph (`@cogni/knowledge-base-ui`), node fetchers, schemas and routes; the legacy Chains grid, WebGL drawing and browser fetch are stubbed. Browse/Graph control behavior is proven package-only in packages/knowledge-base-ui/tests (task.0059).
 * Invariants: NO_HIDDEN_READS, EXPLICIT_CONTINUATION, STALE_INTENT_IGNORED.
 * Side-effects: Stubbed browser fetch; no live services or database.
 * Links: https://github.com/cogni-dao/cogni/issues/2846
 * @vitest-environment jsdom
 * @internal
 */

import { KnowledgeBrowseCursorError } from "@cogni/knowledge-store";
import type { KnowledgeRow } from "@cogni/node-contracts";
import { DataGrid } from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  type Table,
  useReactTable
} from "@tanstack/react-table";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { BoundedBrowse } from "@/app/(app)/knowledge/_components/BoundedBrowse";
import { knowledgeColumns } from "@/app/(app)/knowledge/_components/columns";
import { KnowledgeSelection } from "@/app/(app)/knowledge/_components/KnowledgeSelection";
import { loadKnowledgeBrowse } from "@/app/(app)/knowledge/_server/loaders";
import KnowledgePage from "@/app/(app)/knowledge/page";
import { KnowledgeDashboardView } from "@/app/(app)/knowledge/view";
import { GET as browseRoute } from "@/app/api/v1/knowledge/browse/route";
import { GET as graphRoute } from "@/app/api/v1/knowledge/graph/route";

vi.mock(
  "@cogni/node-contracts",
  async () => import("../../../../packages/knowledge-store/src/contracts")
);
vi.mock("@/app/_facades/read-envelopes.server", () => ({
  toHttpKnowledgeRow: vi.fn()
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
const ssr = vi.hoisted(() => ({ port: undefined as unknown }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ knowledgeStorePort: ssr.port })
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => ({ id: "fixture" })
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/app/_facades/metrics.server", () => ({
  loadGoalsProgress: () => {
    throw new Error("Hidden Goals read");
  }
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler
}));
const routeLog = vi.fn();
function routeContext(routeId: string) {
  return { reqId: "fixture-request", routeId, log: { info: routeLog } };
}
const navigation = vi.hoisted(() => ({ mode: "browse" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ mode: navigation.mode })
}));

// Only the legacy Chains grid and WebGL presentation are replaced. The package
// Browse table, its selection callback, detail fields and relation UI stay real.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    ({
      graphData,
      onNodeClick
    }: {
      graphData: { nodes: Array<{ id: string; title: string }> };
      onNodeClick: (node: { id: string }) => void;
    }) => (
      <div>
        {graphData.nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onNodeClick(node)}
          >
            Select graph {node.title}
          </button>
        ))}
      </div>
    )
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
      }
    };
  }
);
vi.mock(
  "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility",
  () => ({
    DataGridColumnVisibility: () => null
  })
);
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-pagination", () => ({
  DataGridPagination: () => null
}));
vi.mock("@cogni/node-ui-kit/header-filter", () => ({
  HeaderFilter: () => null
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-table", () => ({
  DataGridTable: () => null
}));
vi.mock("@/app/(app)/knowledge/_components/AddDomainSheet", () => ({
  AddDomainSheet: () => null
}));
vi.mock("@/app/(app)/knowledge/_components/ConfidenceBar", () => ({
  ConfidenceBar: () => null
}));
// This suite owns atom selection; automatic goal polling has its own evidence.
vi.mock("@cogni/knowledge-base-ui/goals", () => ({
  GoalsBoard: () => null,
  GoalsProvider: ({ children }: { children: ReactNode }) => children,
  KpiEvidence: () => null,
  MetricEvidence: () => null,
  useGoalsProgress: () => ({ data: undefined }),
  attentionCount: () => 0
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  )
}));
vi.mock("@/components", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Skeleton: () => <span>Loading count</span>,
  Button: ({
    children,
    disabled,
    onClick,
    type = "button"
  }: ComponentProps<"button">) => (
    <button type={type} disabled={disabled} onClick={onClick}>
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
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
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
  resolutionStrategy: null
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
      href: `/knowledge/${selected.id}`
    },
    target: {
      id: `neighbor-${index}`,
      kind: "knowledge",
      title: `Direct relation ${index}`,
      href: `/knowledge/neighbor-${index}`
    },
    context: null
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page = {
  items: [selected],
  nextCursor: null,
  revision: "rev-a",
  scannedRows: 1,
  total: 1
};
/** The whole-corpus graph the graph route serves. */
const graphBody = {
  revision: "rev-a",
  domains: [selected.domain],
  nodes: [
    {
      id: selected.id,
      domain: selected.domain,
      title: selected.title,
      entryType: selected.entryType,
      confidencePct: selected.confidencePct,
      sourceType: selected.sourceType
    }
  ],
  edges: []
};
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
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
      if (url === "/api/v1/knowledge/graph") return Response.json(graphBody);
      if (url.startsWith("/api/v1/knowledge/browse?"))
        return Response.json({ ...page, total: 5046 });
      if (url === `/api/v1/knowledge/${selected.id}`)
        return Response.json(selected);
      if (url.startsWith(`/api/v1/citations/${selected.id}`))
        return Response.json({
          links: Array.from({ length: 5 }, (_, i) => relation(i)),
          nextCursor: "next"
        });
      throw new Error(`Unexpected read ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mount(
      <KnowledgeDashboardView
        initialBrowse={page}
        initialList={
          mode === "chains"
            ? { items: [selected], domains: [selected.domain] }
            : undefined
        }
      />
    );
    await act(async () => {});
    if (mode === "graph")
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The seeded default Browse window's exact total feeds the subtitle with no
    // read; Graph reads the whole corpus once and reports its own exact count.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      mode === "graph" ? ["/api/v1/knowledge/graph"] : []
    );
    await screen.findByText(/What this node has learned · 1 entries on/);
    fetchMock.mockClear();
    fireEvent.click(
      mode === "browse"
        ? screen.getByText(selected.title)
        : await screen.findByRole("button", {
            name: `Select ${mode === "graph" ? "graph" : "row"} ${selected.title}`
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
    // Citation paging lives only in the detail panel's relation list.
    expect(screen.getByRole("button", { name: "More links" })).toBeTruthy();
  }
);

it("SSR reads only the chosen bounded projection and round-trips the wire page", async () => {
  const emptyPage = {
    items: [],
    nextCursor: null,
    revision: "rev-a",
    scannedRows: 0,
    total: 0
  };
  const browseKnowledge = vi.fn(async () => emptyPage);
  const overviewKnowledge = vi.fn(async () => emptyPage);
  const port = new Proxy(
    { browseKnowledge, overviewKnowledge },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        throw new Error(`Unexpected initial read ${String(key)}`);
      }
    }
  );
  expect(await loadKnowledgeBrowse(port as never)).toEqual(emptyPage);
  expect(browseKnowledge).toHaveBeenCalledTimes(1);
  // SSR reads carry a short deadline so slow stores fall back to the client fetch.
  expect(browseKnowledge).toHaveBeenCalledWith(expect.anything(), {
    signal: expect.any(AbortSignal)
  });
  expect(overviewKnowledge).not.toHaveBeenCalled();
  ssr.port = port;
  const browse = await KnowledgePage({ searchParams: Promise.resolve({}) });
  expect(browse.props.initialBrowse).toEqual(emptyPage);
  // Graph is never SSR-seeded: no store read at all for the graph tab.
  const graph = await KnowledgePage({
    searchParams: Promise.resolve({ mode: "graph" })
  });
  expect(graph.props.initialBrowse).toBeUndefined();
  expect(graph.props.initialList).toBeUndefined();
  expect(browseKnowledge).toHaveBeenCalledTimes(2);
  expect(overviewKnowledge).not.toHaveBeenCalled();
});

it("node transport: typing issues no request; submit sends exactly one package-encoded browse window", async () => {
  const reads: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url, "https://node.test");
      reads.push(parsed);
      expect(parsed.pathname).toBe("/api/v1/knowledge/browse");
      expect(init.credentials).toBe("same-origin");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json({
        items: [],
        nextCursor: null,
        revision: "rev-a",
        scannedRows: 5,
        total: 5046
      });
    })
  );
  const user = userEvent.setup();
  mount(<BoundedBrowse initialData={page} />);
  const box = screen.getByRole("textbox", { name: "Search knowledge" });
  await user.type(box, "abcde");
  await act(async () => {});
  expect((box as HTMLInputElement).value).toBe("abcde");
  expect(reads).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText(/Searched 1–5 of 5,046 candidates/);
  expect(reads).toHaveLength(1);
  expect(reads[0]?.searchParams.get("search")).toBe("abcde");
  expect(reads[0]?.searchParams.get("sort")).toBe("createdAt");
  expect(reads[0]?.searchParams.get("direction")).toBe("desc");
  // Enter submits the changed draft as well; an unchanged draft is not replayed.
  await user.type(box, "f{Enter}");
  await waitFor(() => expect(reads).toHaveLength(2));
  expect(reads[1]?.searchParams.get("search")).toBe("abcdef");
  await user.type(box, "{Enter}");
  await act(async () => {});
  expect(reads).toHaveLength(2);
});

it("off-list detail responses cannot replace newer selection", async () => {
  const delayed = new Map<string, (value: Response) => void>();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => delayed.set(url, resolve))
    )
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
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
        content: "New off-list body"
      })
    )
  );
  await screen.findByText("New off-list body");
  await act(async () =>
    delayed.get("/api/v1/knowledge/off-list-old")?.(
      Response.json({
        ...selected,
        id: "off-list-old",
        content: "Stale old body"
      })
    )
  );
  expect(screen.queryByText("Stale old body")).toBeNull();
});

it("thin routes reject malformed and cross-query cursors and preserve repeated exact filters", async () => {
  const browseKnowledge = vi.fn(async (query: { cursor?: string }) => {
    if (query.cursor)
      throw new KnowledgeBrowseCursorError(
        "Browse cursor does not match query"
      );
    return {
      items: [],
      nextCursor: null,
      revision: "rev-a",
      scannedRows: 0,
      total: 0
    };
  });
  ssr.port = { browseKnowledge };
  type Handler = (
    ctx: unknown,
    request: Request,
    user: unknown
  ) => Promise<Response>;
  const invoke = (handler: unknown, query: string) =>
    (handler as Handler)(
      routeContext(
        "knowledge.browse"
      ),
      new Request(`https://node.test/api/v1/knowledge/browse?${query}`),
      { id: "fixture" }
    );
  expect((await invoke(browseRoute, "sort=content")).status).toBe(400);
  expect((await invoke(browseRoute, "cursor=cross-query")).status).toBe(400);
  expect(
    (await invoke(browseRoute, "domains=late&domains=off-page")).status
  ).toBe(200);
  expect(browseKnowledge).toHaveBeenLastCalledWith(
    expect.objectContaining({ domains: ["late", "off-page"] }),
    { signal: expect.any(AbortSignal) }
  );
});

it("legacy columns retain disabled empty headers at the real grid boundary", () => {
  function LegacyEmpty() {
    const table = useReactTable({
      data: [],
      columns: knowledgeColumns,
      getCoreRowModel: getCoreRowModel()
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

it("returns retryable 503 and forwards request abort to bounded reads", async () => {
  const request = new Request("https://node.test/api/v1/knowledge/browse");
  const browseKnowledge = vi.fn(async () => {
    throw Object.assign(new Error("deadline"), { code: "KNOWLEDGE_BUSY" });
  });
  ssr.port = { browseKnowledge };
  const handler = browseRoute as unknown as (
    ctx: unknown,
    request: Request,
    user: unknown
  ) => Promise<Response>;
  const response = await handler(routeContext("knowledge.browse"), request, {
    id: "fixture"
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toEqual({
    error: "Knowledge read unavailable",
    retryable: true
  });
  expect(browseKnowledge).toHaveBeenCalledWith(expect.anything(), {
    signal: request.signal
  });
});

it("Graph shows exact counts in the page subtitle and legend from one read, with the final header", async () => {
  navigation.mode = "graph";
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  const nodes = Array.from({ length: 5046 }, (_, i) => ({
    ...graphBody.nodes[0],
    id: `k-${i}`,
    title: `Entry ${i}`
  }));
  const edges = Array.from({ length: 12300 }, (_, e) => ({
    id: `c-${e}`,
    source: `k-${e % 5046}`,
    target: `k-${(e + 1) % 5046}`,
    citationType: "supports"
  }));
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.cache).toBe("no-store");
    return Response.json({ ...graphBody, nodes, edges });
  });
  vi.stubGlobal("fetch", fetchMock);
  mount(<KnowledgeDashboardView />);
  // Exact counts: the subtitle states every entry on main, the legend every citation.
  await screen.findByText(/What this node has learned · 5,046 entries on/);
  expect(screen.getByText("12300 citations · 1 domain")).toBeTruthy();
  // Final header: Confidence | Domain, Domain hubs, Domain and Type dropdowns; no text inputs.
  expect(
    screen.getByRole("checkbox", { name: "Domain hubs" })
  ).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Domain" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Type" })).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("graph route = auth + readKnowledgeGraph: whole corpus once per revision, 304 on an unchanged revision, 401 before any read", async () => {
  const readKnowledgeGraphSnapshot = vi.fn(async () => ({
    revision: "rev-graph",
    domains: graphBody.domains,
    nodes: graphBody.nodes,
    citations: []
  }));
  ssr.port = { currentCommit: async () => "rev-graph", readKnowledgeGraphSnapshot };
  const handler = graphRoute as unknown as (
    ctx: unknown,
    request: Request,
    user: unknown
  ) => Promise<Response>;
  const call = (
    headers: Record<string, string> = {},
    user: unknown = { id: "fixture" }
  ) =>
    handler(
      routeContext("knowledge.graph"),
      new Request("https://node.test/api/v1/knowledge/graph", { headers }),
      user
    );
  const denied = await call({ "If-None-Match": '"rev-graph"' }, null);
  expect(denied.status).toBe(401);
  expect(readKnowledgeGraphSnapshot).not.toHaveBeenCalled();
  routeLog.mockClear();
  const first = await call();
  expect(first.status).toBe(200);
  expect(first.headers.get("ETag")).toBe('"rev-graph"');
  expect(first.headers.get("Cache-Control")).toBe(
    "private, no-cache, must-revalidate"
  );
  expect(await first.json()).toEqual({ ...graphBody, revision: "rev-graph" });
  expect(routeLog).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "knowledge.graph_read",
      status: 200,
      nodes: 1,
      edges: 0,
      budgetExceeded: false
    }),
    "knowledge.graph_read"
  );
  expect((await call()).status).toBe(200);
  // One pinned projected read per revision, shared by later requests.
  expect(readKnowledgeGraphSnapshot).toHaveBeenCalledTimes(1);
  const unchanged = await call({ "If-None-Match": '"rev-graph"' });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  expect(readKnowledgeGraphSnapshot).toHaveBeenCalledTimes(1);
});

it("SSR deadlines bound connection waiting and never seed a partial page or grow native backlog", async () => {
  const { DoltgresKnowledgeStoreAdapter } = await import(
    "../../../../packages/knowledge-store/src/adapters/doltgres/index"
  );
  vi.useFakeTimers();
  try {
    const sql = {
      options: { max: 2 },
      unsafe: vi.fn(() => new Promise<never>(() => undefined))
    };
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: sql as never,
      browseTimeoutMs: 40
    });
    const failed = expect(loadKnowledgeBrowse(store)).rejects.toMatchObject({
      retryable: true
    });
    await vi.advanceTimersByTimeAsync(40);
    await failed;
    ssr.port = store;
    const pendingPage = KnowledgePage({
      searchParams: Promise.resolve({ mode: "graph" })
    });
    await vi.advanceTimersByTimeAsync(40);
    const shell = await pendingPage;
    expect(shell.props.initialBrowse).toBeUndefined();
    // The graph tab performs no SSR store read.
    expect(sql.unsafe).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["browse"] as const)(
  "%s emits one safe terminal event for each handler outcome",
  async (route) => {
    const handler = browseRoute as unknown as (
      ctx: unknown,
      request: Request,
      user: unknown
    ) => Promise<Response>;
    const run = async (
      query: string,
      operation: (() => Promise<unknown>) | undefined,
      status: number,
      errorCode?: string
    ) => {
      routeLog.mockClear();
      ssr.port = operation ? { [`${route}Knowledge`]: operation } : undefined;
      const response = await handler(
        routeContext(`knowledge.${route}`),
        new Request(`https://node.test/api/v1/knowledge/${route}?${query}`),
        { id: "fixture" }
      );
      expect(response.status).toBe(status);
      expect(routeLog).toHaveBeenCalledTimes(1);
      const [fields, message] = routeLog.mock.calls[0] as [
        Record<string, unknown>,
        string
      ];
      expect(message).toBe(`knowledge.${route}.complete`);
      expect(fields).toMatchObject({
        event: message,
        reqId: "fixture-request",
        routeId: `knowledge.${route}`,
        status,
        outcome: status === 200 ? "success" : "error",
        durationMs: expect.any(Number),
        ...(errorCode
          ? { errorCode }
          : { count: 0, scannedRows: 0, hasMore: false })
      });
      expect(
        Object.keys(fields).every((key) =>
          [
            "event",
            "reqId",
            "routeId",
            "status",
            "durationMs",
            "outcome",
            "errorCode",
            "count",
            "scannedRows",
            "hasMore",
            "searchMode"
          ].includes(key)
        )
      ).toBe(true);
      expect(JSON.stringify(fields)).not.toContain("private-value");
      if (status === 500)
        expect(await response.json()).toEqual({
          error: "Internal server error"
        });
    };
    const success = async () => ({
      items: [],
      nextCursor: null,
      revision: "private-value",
      scannedRows: 0,
      total: 0
    });
    await run("", success, 200);
    await run("sort=private-value", success, 400, "invalid_query");
    await run(
      "cursor=private-value",
      async () => {
        throw new KnowledgeBrowseCursorError("Invalid browse cursor");
      },
      400,
      "invalid_cursor"
    );
    await run(
      "",
      async () => {
        throw Object.assign(new Error("private-value"), {
          code: "KNOWLEDGE_BUSY"
        });
      },
      503,
      "unavailable"
    );
    await run(
      "",
      async () => {
        throw new Error("private-value");
      },
      500,
      "internal_error"
    );
    await run("", undefined, 503, "store_unconfigured");
  }
);
