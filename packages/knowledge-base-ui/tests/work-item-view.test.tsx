// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/tests/work-item-view`
 * Purpose: Prove a fork that renders `WorkItemView` from the package alone draws every section node-template draws, in order, and
 *   every control works: open and close an artifact, Older and Newest on both lists, the roadmap on links page 2, not found,
 *   error and loading (story.0085). Also proves the read client's URLs, parsing and typed errors.
 * Scope: Package exports, a fixture client and a fixture `fetch`. No node app code, router or node UI kit.
 * Invariants: ONE_VIEW, SECTIONS_NEED_THEIR_PARTS, ITEM_SCOPED_URL, BOUNDED, STATUS_ON_ERROR.
 * Side-effects: DOM rendering in jsdom
 * Links: ../src/work-item-view.tsx, ../src/work-item-client.ts, hub work-item-view-capability
 */

import "@testing-library/jest-dom/vitest";

import type { WorkItemReadDto } from "@cogni/work-items";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderUi, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkItemClient,
  type WorkItemClient,
  WorkItemReadError,
  WorkItemView,
  type WorkItemViewProps,
} from "../src/work-item.js";

afterEach(cleanup);

const at = "2026-11-19T00:00:00.000Z";
const ref = (id: string, seq: number, kind: "design_review" | "validation", verdict: string) => ({
  id,
  seq,
  kind,
  verdict,
  passGrade: verdict === "pass" || verdict === "approve",
  subject: "s",
  itemRevision: seq,
  createdAt: at,
});
const history = (commit: string, reason: string | null) => ({
  version: commit,
  commit,
  at,
  actor: null,
  reason,
  cites: [],
  changed: ["status"],
});
const link = (n: number, over: Record<string, unknown> = {}) => ({
  id: `c${n}`,
  direction: "out" as const,
  citationType: "supports",
  source: { id: "task.1", kind: "work" as const, title: null, href: "/work/items/task.1" },
  target: { id: `atom-${n}`, kind: "knowledge" as const, title: null, href: `/knowledge/atom-${n}` },
  context: null,
  label: "supports",
  tone: "positive" as const,
  ...over,
});

const item: WorkItemReadDto = {
  id: "task.1",
  type: "task",
  title: "Ship the whole view",
  status: "needs_implement",
  priority: 1,
  summary: "Summary text",
  outcome: "Outcome text",
  branch: "feat/view",
  labels: ["goal:goal-ai-work-converges"],
  assignees: [{ kind: "agent", agentId: "agent-7" }],
  specRefs: ["knowledge:work-item-view-capability"],
  pr: "https://github.com/cogni-dao/node-template/pull/450",
  externalRefs: [{ system: "github", kind: "pr", url: "https://github.com/cogni-dao/poly/pull/9" }],
  scores: {
    goal: { v: 3 },
    time: { v: 3 },
    unblocks: { v: 4 },
    ease: { v: 2 },
    confidence: { v: 4 },
    agent: { v: 4 },
  },
  revision: 3,
  deployVerified: false,
  createdAt: at,
  updatedAt: at,
  links: {
    items: [1, 2, 3, 4, 5].map((n) => link(n)),
    nextCursor: "c5",
  },
  artifactRefs: { refs: [ref("wia-2", 2, "validation", "pass"), ref("wia-1", 1, "design_review", "request_changes")], nextCursor: 1 },
  historyRefs: { refs: [history("h2", "Moved to implement"), history("h1", null)], nextCursor: "h1" },
} as WorkItemReadDto;

function fixtureClient(over: Partial<WorkItemClient> = {}): WorkItemClient {
  return {
    fetchItem: vi.fn(async () => item),
    fetchArtifactRefs: vi.fn(async () => ({ refs: [ref("wia-0", 0 + 1, "design_review", "approve")], nextCursor: null })),
    fetchHistoryRefs: vi.fn(async () => ({ refs: [history("h0", "Older reason")], nextCursor: null })),
    fetchCitationLinks: vi.fn(async (_id: string, cursor?: string) =>
      cursor === "c5"
        ? {
            links: [
              link(6, {
                direction: "in",
                citationType: "tracks",
                source: { id: "roadmap-converge", kind: "knowledge", title: null, href: "/knowledge/roadmap-converge" },
                target: { id: "task.1", kind: "work", title: null, href: "/work/items/task.1" },
              }),
            ],
            nextCursor: null,
          }
        : { links: [], nextCursor: null }
    ),
    fetchExpectations: vi.fn(async () => ({
      items: [
        {
          id: "hyp.1",
          title: "Expectation one",
          content: "c",
          predictions: [{ metricId: "m", expected: "gte 4 count", observed: "met" }],
          outcomes: [],
          truncated: false,
        },
      ],
      truncated: false,
    })),
    ...over,
  };
}

const Markdown = ({ content }: { readonly content: string }) => <div data-markdown>{content}</div>;
const itemHref = (id: string, params: URLSearchParams) => {
  const query = params.toString();
  return `/work/items/${id}${query ? `?${query}` : ""}`;
};

function render(props: Partial<WorkItemViewProps> = {}): { client: WorkItemClient } {
  const client = props.client ?? fixtureClient();
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <WorkItemView item={item} itemId="task.1" client={client} itemHref={itemHref} Markdown={Markdown} {...props} />
  );
  renderUi(ui, { wrapper: ({ children }) => <QueryClientProvider client={query}>{children}</QueryClientProvider> });
  return { client };
}

describe("WorkItemView", () => {
  it("draws every section in node-template's order from the package alone", async () => {
    render();
    expect(screen.getByRole("heading", { name: "Ship the whole view" })).toBeInTheDocument();
    const order = [
      screen.getByRole("region", { name: "Pull requests" }),
      screen.getByRole("region", { name: "Moves" }),
      screen.getByRole("region", { name: "Design" }),
      screen.getByRole("region", { name: "Artifacts" }),
      await screen.findByText("Expectation one"),
      screen.getByText("Evaluation"),
      screen.getByText("Summary text"),
      screen.getByText("Outcome text"),
      screen.getByText("History"),
      screen.getByText("Branch"),
      screen.getByText("Labels"),
      screen.getByText("agent-7"),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]?.compareDocumentPosition(order[i] as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
    expect(screen.getAllByRole("link", { name: /^pr / }).map((a) => a.getAttribute("href"))).toEqual([
      "https://github.com/cogni-dao/node-template/pull/450",
      "https://github.com/cogni-dao/poly/pull/9",
    ]);
    expect(screen.getByRole("link", { name: "design work-item-view-capability" })).toBeInTheDocument();
  });

  it("finds the roadmap on links page 2 through the client, within the page budget", async () => {
    const { client } = render();
    expect(await screen.findByRole("link", { name: "roadmap roadmap-converge" })).toBeInTheDocument();
    expect(client.fetchCitationLinks).toHaveBeenCalledWith("task.1", "c5", expect.anything());
  });

  it("opens an artifact through the item URL and closes it from the same row", () => {
    render({
      searchParams: new URLSearchParams("q=x&artifact=wia-2"),
      item: {
        ...item,
        artifact: {
          id: "wia-2",
          itemId: "task.1",
          seq: 2,
          itemRevision: 2,
          kind: "validation",
          subject: "s",
          verdict: "pass",
          author: "u",
          createdAt: at,
          body: "Scorecard body",
        },
      } as WorkItemReadDto,
    });
    const artifacts = screen.getByRole("region", { name: "Artifacts" });
    expect(within(artifacts).getByRole("link", { name: /pass Validation 1 · this item/ })).toHaveAttribute(
      "href",
      "/work/items/task.1?q=x"
    );
    expect(within(artifacts).getByRole("link", { name: /request changes Design review 1 · this item/ })).toHaveAttribute(
      "href",
      "/work/items/task.1?q=x&artifact=wia-1"
    );
    expect(within(artifacts).getByText("Scorecard body")).toBeInTheDocument();
  });

  it("Older replaces each list with the client's older page, and Newest returns", async () => {
    const { client } = render({ searchParams: new URLSearchParams("artifactsCursor=1&historyCursor=h1") });
    expect(await screen.findByText("Older reason")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /approve Design review 1/ })).toBeInTheDocument();
    expect(client.fetchArtifactRefs).toHaveBeenCalledWith("task.1", "1", expect.anything());
    expect(client.fetchHistoryRefs).toHaveBeenCalledWith("task.1", "h1", expect.anything());
    const newest = screen.getAllByRole("link", { name: "Newest" }).map((a) => a.getAttribute("href"));
    expect(newest).toEqual(["/work/items/task.1?historyCursor=h1", "/work/items/task.1?artifactsCursor=1"]);
  });

  it("page 1 offers Older on both lists", () => {
    render();
    expect(screen.getAllByRole("link", { name: "Older" }).map((a) => a.getAttribute("href"))).toEqual([
      "/work/items/task.1?artifactsCursor=1",
      "/work/items/task.1?historyCursor=h1",
    ]);
  });

  it("draws no Artifacts or History for a read without those parts", () => {
    const { artifactRefs: _a, historyRefs: _h, ...bare } = item;
    render({ item: bare as WorkItemReadDto });
    expect(screen.queryByRole("region", { name: "Artifacts" })).toBeNull();
    expect(screen.queryByText("History")).toBeNull();
  });

  it("names loading, not found and error through the node's header slots", () => {
    const Title = ({ children }: { readonly children?: React.ReactNode }) => <h1 data-slot="title">{children}</h1>;
    render({ item: null, isLoading: true, Title });
    expect(screen.getByRole("heading", { name: "Loading work item" })).toHaveAttribute("data-slot", "title");
    cleanup();
    render({ item: null, error: new WorkItemReadError("item", 404) });
    expect(screen.getByRole("heading", { name: "Work item not found" })).toBeInTheDocument();
    cleanup();
    render({ item: null, error: new WorkItemReadError("item", 503) });
    expect(screen.getByRole("heading", { name: "Unable to load work item" })).toBeInTheDocument();
    expect(screen.queryByText("Work item not found")).toBeNull();
  });
});

describe("createWorkItemClient", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("reads each route under the base URL and parses its body", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("/citations/")) return ok({ links: [], nextCursor: null });
      if (String(url).includes("/artifacts")) return ok({ refs: [], nextCursor: null });
      if (String(url).includes("/history")) return ok({ refs: [], nextCursor: null });
      if (String(url).includes("/expectations")) return ok({ items: [], truncated: false });
      return ok(item);
    }) as unknown as typeof fetch;
    const client = createWorkItemClient({ baseUrl: "/node/api/v1/", fetch: fetcher });
    await client.fetchItem("task.1", { artifact: "wia-2" });
    await client.fetchArtifactRefs("task.1", "4");
    await client.fetchHistoryRefs("task.1", "abc");
    await client.fetchCitationLinks("task.1");
    await client.fetchCitationLinks("task.1", "c5");
    await client.fetchExpectations("task.1", new AbortController().signal, []);
    expect(calls).toEqual([
      "/node/api/v1/work/items/task.1?include=links%2Cartifacts%2Chistory&artifact=wia-2",
      "/node/api/v1/work/items/task.1/artifacts?view=refs&cursor=4",
      "/node/api/v1/work/items/task.1/history?view=refs&cursor=abc",
      "/node/api/v1/citations/task.1",
      "/node/api/v1/citations/task.1?cursor=c5",
      "/node/api/v1/work/items/task.1/expectations",
    ]);
  });

  it("a failed read throws its HTTP status; a malformed body is refused", async () => {
    const denied = createWorkItemClient({ fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch });
    await expect(denied.fetchItem("task.1")).rejects.toMatchObject({ name: "WorkItemReadError", status: 403 });
    const malformed = createWorkItemClient({ fetch: (async () => ok({ items: "nope" })) as unknown as typeof fetch });
    await expect(malformed.fetchExpectations("task.1", new AbortController().signal, [])).rejects.toThrow();
  });
});
