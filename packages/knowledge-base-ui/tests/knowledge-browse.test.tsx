// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-browse.test`
 * Purpose: Drives every Browse control against fixture fetchers: one metadata window on load and no body read, submit-only search, an empty capped window that offers Continue, Retry on the same cursor, Restart, abort on filter change, header filters at capacity, and the revision prompt (task.0059).
 * Scope: Package exports only (`KnowledgeBrowse`, `useKnowledgeBrowse`, codec) under a real React Query client. No node app code, no private UI kit.
 * Side-effects: DOM rendering in jsdom
 * Links: task.0059, ../src/knowledge-browse.tsx, ../src/use-knowledge-windows.ts
 */

// @vitest-environment jsdom

import type {
  KnowledgeBrowsePage,
  KnowledgeSummary,
} from "@cogni/knowledge-store/contracts";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
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
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KnowledgeBrowse,
  type KnowledgeWindowFetcher,
  knowledgeBrowseKey,
  knowledgeQueryToSearchParams,
  useKnowledgeBrowse,
} from "../src/knowledge.js";

const entry: KnowledgeSummary = {
  id: "node-template-selected-decision",
  domain: "meta",
  entityId: null,
  title: "node-template selected decision",
  useWhen: null,
  entryType: "decision",
  confidencePct: 80,
  sourceType: "human",
  createdAt: null,
};

const windowOf = (
  over: Partial<KnowledgeBrowsePage> = {},
): KnowledgeBrowsePage => ({
  items: [entry],
  nextCursor: null,
  revision: "rev-a",
  scannedRows: 1,
  ...over,
});

const ENTRY_TYPES = ["guide", "decision", "rule"];
const SOURCE_TYPES = ["human", "agent"];

afterEach(() => cleanup());

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function mount(
  fetchBrowse: KnowledgeWindowFetcher,
  initialData?: KnowledgeBrowsePage,
  client = newClient(),
  onSelect?: (entry: KnowledgeSummary) => void,
) {
  const ui = () => (
    <QueryClientProvider client={client}>
      <KnowledgeBrowse
        fetchBrowse={fetchBrowse}
        initialData={initialData}
        entryTypeOptions={ENTRY_TYPES}
        sourceTypeOptions={SOURCE_TYPES}
        {...(onSelect && { onSelect })}
      />
    </QueryClientProvider>
  );
  return { ...render(ui()), client, ui };
}

/** A fixture fetcher that records each request's parameters and signal. */
function recorder(respond: (params: URLSearchParams) => Promise<KnowledgeBrowsePage>) {
  const reads: URLSearchParams[] = [];
  const signals: AbortSignal[] = [];
  const fetchBrowse = vi.fn<KnowledgeWindowFetcher>(async (params, signal) => {
    reads.push(params);
    signals.push(signal);
    return respond(params);
  });
  return { reads, signals, fetchBrowse };
}

function submitSearch(value: string) {
  const box = screen.getByRole("textbox", { name: "Search knowledge" });
  fireEvent.change(box, { target: { value } });
  fireEvent.submit(required(box.closest("form")));
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing required fixture value");
  return value;
}

describe("knowledge query codec", () => {
  it("encodes the store schema's parse with repeated exact-value keys", () => {
    const params = knowledgeQueryToSearchParams({
      domains: ["b", "a", "a"],
      search: "body",
    });
    expect(params.getAll("domains")).toEqual(["a", "b"]);
    expect(params.get("sort")).toBe("createdAt");
    expect(params.get("direction")).toBe("desc");
    expect(params.get("search")).toBe("body");
    expect(() => knowledgeQueryToSearchParams({ search: "x" }, "overview")).toThrow();
  });
});

describe("KnowledgeBrowse", () => {
  it("loads exactly one metadata window on open and never a body read", async () => {
    const { reads, fetchBrowse } = recorder(async () => windowOf());
    mount(fetchBrowse);
    await screen.findByText(entry.title);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.has("search")).toBe(false);
    expect(reads[0]?.has("cursor")).toBe(false);
    expect(screen.getByText(/1 entries in this window · end of results/)).toBeTruthy();
  });

  it("an SSR-seeded default window issues no request at all", async () => {
    const { reads, fetchBrowse } = recorder(async () => windowOf());
    mount(fetchBrowse, windowOf());
    await act(async () => {});
    expect(reads).toHaveLength(0);
    expect(screen.getByText(/Observed revision: rev-a/)).toBeTruthy();
  });

  it("never shows the empty-results message before the first read settles", async () => {
    const fetchBrowse = vi.fn<KnowledgeWindowFetcher>(
      () => new Promise<KnowledgeBrowsePage>(() => undefined),
    );
    mount(fetchBrowse);
    await act(async () => {});
    expect(screen.queryByText("No entries match these filters.")).toBeNull();
  });

  it("typing issues no request until submit, then exactly one window; an unchanged draft is not replayed", async () => {
    const { reads, fetchBrowse } = recorder(async () =>
      windowOf({ items: [], scannedRows: 5 }),
    );
    const user = userEvent.setup();
    mount(fetchBrowse, windowOf());
    const box = screen.getByRole("textbox", { name: "Search knowledge" });
    await user.type(box, "abcde");
    await act(async () => {});
    expect(reads).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText(/5 candidates searched/);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.get("search")).toBe("abcde");
    await user.type(box, "f{Enter}");
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1]?.get("search")).toBe("abcdef");
    await user.type(box, "{Enter}");
    await act(async () => {});
    expect(reads).toHaveLength(2);
  });

  it("an empty capped search window offers Continue; a failed window retries its own cursor; Restart returns to the first window", async () => {
    let failed = false;
    const { reads, fetchBrowse } = recorder(async (params) => {
      if (params.get("cursor") === "after-20") {
        if (!failed) {
          failed = true;
          throw Object.assign(new Error("deadline"), { status: 503 });
        }
        return windowOf();
      }
      return windowOf({ items: [], nextCursor: "after-20", scannedRows: 20 });
    });
    mount(fetchBrowse, windowOf());
    submitSearch("body");
    await screen.findByText(/20 candidates searched · continuation available/);
    expect(
      screen.getByText(
        "No matches in this window. Continue search to examine more entries.",
      ),
    ).toBeTruthy();
    expect(reads).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Continue search" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry window" }));
    await screen.findByText(entry.title);
    expect(reads.slice(1).map((params) => params.get("cursor"))).toEqual([
      "after-20",
      "after-20",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Previous window" }));
    await screen.findByText(/20 candidates searched/);
    fireEvent.click(screen.getByRole("button", { name: "Continue search" }));
    await screen.findByText(entry.title);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(reads.at(-1)?.get("cursor")).toBeNull());
    expect(reads.every((params) => params.get("search") === "body")).toBe(true);
  });

  it("a filter change aborts the in-flight window and starts over at the first window", async () => {
    const signals: AbortSignal[] = [];
    const reads: URLSearchParams[] = [];
    const fetchBrowse = vi.fn<KnowledgeWindowFetcher>((params, signal) => {
      reads.push(params);
      signals.push(signal);
      if (params.getAll("domains").length === 0)
        return new Promise<KnowledgeBrowsePage>(() => undefined);
      return Promise.resolve(windowOf({ items: [] }));
    });
    const client = newClient();
    const { result, rerender } = renderHook(
      ({ domains }: { domains: string[] }) =>
        useKnowledgeBrowse({ query: { domains }, fetchBrowse }),
      {
        initialProps: { domains: [] as string[] },
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(reads).toHaveLength(1));
    const pending = required(signals[0]);
    expect(pending.aborted).toBe(false);
    rerender({ domains: ["off-page"] });
    await waitFor(() => expect(result.current.page?.items).toEqual([]));
    expect(pending.aborted).toBe(true);
    expect(reads.at(-1)?.getAll("domains")).toEqual(["off-page"]);
    expect(reads.at(-1)?.has("cursor")).toBe(false);
  });

  it("header filters write exact global values to the query and cap selection at 50", async () => {
    const { reads, fetchBrowse } = recorder(async () =>
      windowOf({ items: [], scannedRows: 0 }),
    );
    const user = userEvent.setup();
    mount(fetchBrowse, windowOf({ items: [], scannedRows: 0 }));
    submitSearch("body");
    await waitFor(() => expect(reads).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Filter Domain" }));
    const domain = await screen.findByRole("textbox", { name: "Exact Domain" });
    fireEvent.change(domain, { target: { value: "off-page" } });
    fireEvent.submit(required(domain.closest("form")));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(reads.at(-1)?.getAll("domains")).toEqual(["off-page"]),
    );
    await user.click(screen.getByRole("button", { name: "Filter Type" }));
    const input = await screen.findByRole("textbox", { name: "Exact Type" });
    for (let i = 0; i < 50; i++) {
      fireEvent.change(input, { target: { value: `custom-${i}` } });
      fireEvent.submit(required(input.closest("form")));
    }
    const canonical = screen.getByRole("button", { name: "guide" });
    expect(canonical.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Maximum 50 values selected/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "custom-0" }));
    expect(canonical.hasAttribute("disabled")).toBe(false);
    await user.click(canonical);
    await waitFor(() => {
      const params = required(reads.at(-1));
      expect(params.getAll("entryTypes")).toHaveLength(50);
      expect(params.getAll("entryTypes")).toContain("guide");
      expect(params.getAll("entryTypes")).not.toContain("custom-0");
      expect(params.getAll("domains")).toEqual(["off-page"]);
      expect(params.get("search")).toBe("body");
    });
  });

  it("sort headers write the server sort, announce it with aria-sort, and keep the filters", async () => {
    const { reads, fetchBrowse } = recorder(async () =>
      windowOf({ items: [], scannedRows: 0 }),
    );
    const user = userEvent.setup();
    mount(fetchBrowse, windowOf({ items: [], scannedRows: 0 }));
    expect(
      screen.getByRole("columnheader", { name: /Created/ }).getAttribute("aria-sort"),
    ).toBe("descending");
    for (const [label, sort] of [
      ["Domain", "domain"],
      ["Type", "entryType"],
      ["Source", "sourceType"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: label, exact: true }));
      await waitFor(() => expect(reads.at(-1)?.get("sort")).toBe(sort));
      expect(
        screen.getByRole("columnheader", { name: new RegExp(label) }).getAttribute("aria-sort"),
      ).toBe("ascending");
      expect(reads.at(-1)?.get("direction")).toBe("asc");
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: label, exact: true })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
    }
    const confidence = screen.getByRole("button", { name: "Confidence", exact: true });
    await user.click(confidence);
    await waitFor(() => expect(reads.at(-1)?.get("sort")).toBe("confidencePct"));
    expect(reads.every((params) => !params.has("cursor"))).toBe(true);
  });

  it("header filters are reachable and toggled with Tab and Enter alone", async () => {
    const { reads, fetchBrowse } = recorder(async () =>
      windowOf({ items: [], scannedRows: 0 }),
    );
    const user = userEvent.setup();
    mount(fetchBrowse, windowOf({ items: [], scannedRows: 0 }));
    const trigger = screen.getByRole("button", { name: "Filter Type" });
    for (let i = 0; i < 40 && document.activeElement !== trigger; i++)
      await user.tab();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}");
    const guide = await screen.findByRole("button", { name: "guide" });
    for (let i = 0; i < 20 && document.activeElement !== guide; i++)
      await user.tab();
    expect(document.activeElement).toBe(guide);
    await user.keyboard("{Enter}");
    expect(guide.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() =>
      expect(reads.at(-1)?.getAll("entryTypes")).toEqual(["guide"]),
    );
  });

  it("row activation ignores keys aimed at a control inside the row", async () => {
    const onSelect = vi.fn();
    mount(vi.fn<KnowledgeWindowFetcher>(), windowOf(), newClient(), onSelect);
    const copy = screen.getByRole("button", { name: "Copy block link" });
    fireEvent.keyDown(copy, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(required(copy.closest("tr")), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(entry);
  });

  it("returning to an earlier query starts at its first window", async () => {
    const reads: URLSearchParams[] = [];
    const fetchBrowse = vi.fn<KnowledgeWindowFetcher>(async (params) => {
      reads.push(params);
      return windowOf({ nextCursor: params.has("cursor") ? null : "after-20" });
    });
    const client = newClient();
    const { result, rerender } = renderHook(
      ({ domains }: { domains: string[] }) =>
        useKnowledgeBrowse({ query: { domains }, fetchBrowse }),
      {
        initialProps: { domains: ["a"] },
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(result.current.canNext).toBe(true));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.query.cursor).toBe("after-20"));
    rerender({ domains: ["b"] });
    expect(result.current.query.cursor).toBeUndefined();
    rerender({ domains: ["a"] });
    expect(result.current.query.cursor).toBeUndefined();
    expect(result.current.canPrevious).toBe(false);
    await waitFor(() => expect(result.current.page?.nextCursor).toBe("after-20"));
    // gcTime 0 drops A's first window, so returning rereads it: without a cursor.
    expect(
      reads.filter((p) => p.getAll("domains").join() === "a").map((p) => p.get("cursor")),
    ).toEqual([null, "after-20", null]);
  });

  it("Clear filters always returns to the first window", async () => {
    const { reads, fetchBrowse } = recorder(async (params) =>
      windowOf({ nextCursor: params.has("cursor") ? null : "after-20" }),
    );
    mount(fetchBrowse);
    await screen.findByText(/more available/);
    fireEvent.click(screen.getByRole("button", { name: "Next window" }));
    await screen.findByText(/end of results/);
    expect(reads.at(-1)?.get("cursor")).toBe("after-20");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await screen.findByText(/more available/);
    expect(
      screen.getByRole("button", { name: "Previous window" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("selecting a row hands the summary to the node without any read", async () => {
    const { reads, fetchBrowse } = recorder(async () => windowOf());
    const onSelect = vi.fn();
    mount(fetchBrowse, windowOf(), newClient(), onSelect);
    fireEvent.click(screen.getByText(entry.title));
    expect(onSelect).toHaveBeenCalledWith(entry);
    expect(reads).toHaveLength(0);
  });

  it("stale body windows ignore focus and reconnect, and a remount awaits intent", async () => {
    const { reads, fetchBrowse } = recorder(async () =>
      windowOf({ items: [], nextCursor: "after-20", scannedRows: 20 }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = mount(fetchBrowse, windowOf(), client);
    submitSearch("body");
    await screen.findByText(/20 candidates searched/);
    const key = knowledgeBrowseKey({ search: "body" });
    client.setQueryData(key, client.getQueryData(key), {
      updatedAt: Date.now() - 60_000,
    });
    try {
      await act(async () => {
        focusManager.setFocused(false);
        onlineManager.setOnline(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(true);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(reads).toHaveLength(1);
      first.unmount();
      render(first.ui());
      await act(async () => {});
      expect(reads).toHaveLength(1);
    } finally {
      client.clear();
      focusManager.setFocused(undefined);
      onlineManager.setOnline(true);
    }
  });

  it("offers Restart after a revision change or a known mutation without rescanning, and Restart clears it", async () => {
    let revision = "rev-a";
    const { reads, fetchBrowse } = recorder(async () =>
      windowOf({ items: [], nextCursor: "next-window", scannedRows: 20, revision }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount(fetchBrowse, windowOf(), client);
    submitSearch("body");
    await screen.findByText(/20 candidates searched/);
    revision = "rev-b";
    fireEvent.click(screen.getByRole("button", { name: "Continue search" }));
    const prompt = "Knowledge changed. Restart to begin a new live traversal.";
    await screen.findByText(prompt);
    expect(reads).toHaveLength(2);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["knowledge"] });
    });
    expect(reads).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(reads[2]?.get("cursor")).toBeNull();
    await waitFor(() => expect(screen.queryByText(prompt)).toBeNull());
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["knowledge"] });
    });
    expect(screen.getByText(prompt)).toBeTruthy();
    expect(reads).toHaveLength(3);
    client.clear();
  });
});
