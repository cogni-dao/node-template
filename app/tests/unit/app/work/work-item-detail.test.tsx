// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Proves every open work-item sheet state is named and described. */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import type { WorkItemDto } from "@cogni/node-contracts";
import { cleanup, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, useRef, useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkItemFetchError } from "@/app/(app)/work/_api/fetchWorkItems";
import { WorkItemDetail } from "@/app/(app)/work/_components/WorkItemDetail";
import { WorkDetailSheet } from "@/app/(app)/work/_components/WorkDetailSheet";

vi.mock("@/app/(app)/work/_components/work-item-icons", () => ({ TypeIcon: () => null, StatusPill: () => null }));

vi.mock("@/app/(app)/_components/EntityCitationLinks", () => ({
  EntityCitationLinks: () => null,
}));

const item: WorkItemDto = {
  id: "task.5174",
  type: "task",
  title: "Canonical work-item permalink",
  status: "needs_implement",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 1,
  deployVerified: false,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};

const clients = new Set<QueryClient>();
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.add(client);
  return renderUi(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
  vi.restoreAllMocks();
});

function expectAccessibleDialog(
  name: string,
  description: RegExp
): HTMLElement {
  const dialog = screen.getByRole("dialog", { name });
  expect(dialog).toHaveAccessibleDescription(description);
  return dialog;
}

describe("WorkItemDetail accessibility", () => {
  it("names and describes the loading state", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <WorkItemDetail
        item={null}
        itemId="task.5174"
        isLoading
        open
        onOpenChange={vi.fn()}
      />
    );

    expectAccessibleDialog(
      "Loading work item",
      /Loading details for task\.5174/
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("names and describes only a typed 404 as not-found", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <WorkItemDetail
        item={null}
        itemId="task.5174"
        error={new WorkItemFetchError("missing", 404)}
        open
        onOpenChange={vi.fn()}
      />
    );

    expectAccessibleDialog(
      "Work item not found",
      /No work item with id task\.5174/
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("names and describes operational failures without calling them 404", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <WorkItemDetail
        item={null}
        itemId="task.5174"
        error={new WorkItemFetchError("busy", 503)}
        open
        onOpenChange={vi.fn()}
      />
    );

    expectAccessibleDialog(
      "Unable to load work item",
      /could not load task\.5174/
    );
    expect(screen.queryByText("Work item not found")).not.toBeInTheDocument();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("names and describes the loaded item", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <WorkItemDetail
        item={item}
        itemId={item.id}
        open
        onOpenChange={vi.fn()}
      />
    );

    expectAccessibleDialog(item.title, /Details for task\.5174/);
    expect(errorSpy).not.toHaveBeenCalled();
  });
  it("leads with every PR, then links the design atoms (story.0069)", () => {
    render(
      <WorkItemDetail
        item={{
          ...item,
          specRefs: ["knowledge:work-item-design-links"],
          pr: "https://github.com/cogni-dao/node-template/pull/425",
          externalRefs: [
            { system: "github", kind: "pr", url: "https://github.com/cogni-dao/red/pull/45" },
            { system: "github", kind: "pr", url: "https://github.com/cogni-dao/node-template/pull/425" },
            { system: "github", kind: "issue", url: "https://github.com/cogni-dao/node-template/issues/1" },
          ],
        }}
        itemId={item.id}
        open
        onOpenChange={vi.fn()}
      />
    );

    const prs = screen.getAllByRole("link", { name: /^outgoing pr / });
    expect(prs.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/cogni-dao/node-template/pull/425",
      "https://github.com/cogni-dao/red/pull/45",
    ]);
    expect(prs[0]).toHaveAttribute("target", "_blank");
    const links = screen.getAllByRole("link");
    expect(links.indexOf(prs[0] as HTMLElement)).toBe(0);
    expect(screen.getByRole("link", { name: "outgoing design work-item-design-links" })).toHaveAttribute(
      "href",
      "/knowledge/work-item-design-links"
    );
  });
  it("shows artifact and history refs, and the selected validation's scorecard, only when the read carries them", () => {
    render(
      <WorkItemDetail
        item={{
          ...item,
          artifactRefs: {
            refs: [
              { id: "wia-2", seq: 2, kind: "validation", verdict: "pass", passGrade: true, subject: "s", itemRevision: 3, createdAt: "2026-10-03T00:00:00.000Z" },
              { id: "wia-1", seq: 1, kind: "design_review", verdict: "request_changes", subject: "s", itemRevision: 2, createdAt: "2026-10-02T00:00:00.000Z" },
            ],
            nextCursor: 1,
          },
          historyRefs: {
            refs: [{ version: "2", commit: "c2", at: "2026-10-03T00:00:00.000Z", actor: null, reason: null, cites: [], changed: ["status"] }],
            nextCursor: null,
          },
          artifact: {
            id: "wia-2", itemId: item.id, seq: 2, itemRevision: 3, kind: "validation", subject: "s", verdict: "pass", author: "u",
            createdAt: "2026-10-03T00:00:00.000Z",
            rows: [{ tweak: "REFS ROUTE", human: "—", ai: "🟢", loki: "🟢", trace: "—", overall: "🟢 PASS" }],
          },
        }}
        itemId={item.id}
        open
        onOpenChange={vi.fn()}
      />
    );
    // Drawn like Moves: one bordered list of CitationRows, below Moves; the selected one opens inline and its link closes it.
    expect(screen.getByRole("link", { name: /request changes Design review 1 · this item/ })).toHaveAttribute(
      "href",
      "/work/items/task.5174?artifact=wia-1",
    );
    expect(screen.getByRole("link", { name: /pass Validation 1 · this item/ })).toHaveAttribute("href", "/work/items/task.5174");
    expect(screen.getAllByText(/^Artifacts?$/)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Older" })).toHaveAttribute("href", "/work/items/task.5174?artifactsCursor=1");
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "REFS ROUTE" })).toBeInTheDocument();
  });

  it("says the artifact is not found, and the reviews unavailable, instead of an empty answer", () => {
    render(
      <WorkItemDetail
        item={{ ...item, artifactRefs: { refs: [], nextCursor: null, unavailable: true }, artifact: { notFound: true } }}
        itemId={item.id}
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByText("Artifact not found")).toBeInTheDocument();
    expect(screen.getByText("Reviews are unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No reviews yet")).not.toBeInTheDocument();
  });

  it("opens a selected artifact that is not on the shown page below the list", () => {
    render(
      <WorkItemDetail
        item={{
          ...item,
          artifactRefs: { refs: [], nextCursor: null },
          artifact: {
            id: "wia-9", itemId: item.id, seq: 9, itemRevision: 3, kind: "design_review", subject: "s", verdict: "approve",
            author: "u", createdAt: "2026-10-03T00:00:00.000Z", body: "Older review text",
          },
        }}
        itemId={item.id}
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByText("Older review text")).toBeInTheDocument();
  });

  it("renders no Artifacts or History section for a read without those parts", () => {
    render(<WorkItemDetail item={item} itemId={item.id} open onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Artifacts")).not.toBeInTheDocument();
    expect(screen.queryByText("History")).not.toBeInTheDocument();
  });
});


describe("Work detail shell", () => {
  it("keeps a single named dialog and restores the opener after close", async () => {
    const opener = createRef<HTMLButtonElement>();
    const fallback = createRef<HTMLHeadingElement>();
    const onOpenChange = vi.fn();
    const view = render(<><h1 ref={fallback} tabIndex={-1}>Work</h1><button type="button" ref={opener}>Open</button><WorkDetailSheet item={item} itemId={item.id} open={false} onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    expect(screen.queryByRole("dialog")).toBeNull();
    opener.current?.focus();
    view.rerender(<><h1 ref={fallback} tabIndex={-1}>Work</h1><button type="button" ref={opener}>Open</button><WorkDetailSheet item={item} itemId={item.id} open onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    expect(await screen.findByRole("dialog", { name: item.title })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    view.rerender(<><h1 ref={fallback} tabIndex={-1}>Work</h1><button type="button" ref={opener}>Open</button><WorkDetailSheet item={null} open={false} onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    await waitFor(() => expect(opener.current).toHaveFocus());
  });

  it("returns direct-link focus to the Work heading when there is no opener", async () => {
    const opener = createRef<HTMLButtonElement>();
    const fallback = createRef<HTMLHeadingElement>();
    const onOpenChange = vi.fn();
    const view = render(<><h1 ref={fallback} tabIndex={-1}>Work</h1><WorkDetailSheet item={item} itemId={item.id} open onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    await screen.findByRole("dialog", { name: item.title });
    view.rerender(<><h1 ref={fallback} tabIndex={-1}>Work</h1><WorkDetailSheet item={null} open={false} onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    await waitFor(() => expect(fallback.current).toHaveFocus());
  });
});

describe("deferred Work detail", () => {
  it("does not reopen after closing during a pending module load, and selects B", async () => {
    vi.resetModules();
    let release: (() => void) | undefined;
    let moduleRequested = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.doMock("@/app/(app)/work/_components/WorkItemDetailBody", async (actual) => {
      moduleRequested = true;
      await pending;
      return await actual();
    });
    const { WorkDetailSheet: DeferredSheet } = await import("@/app/(app)/work/_components/WorkDetailSheet");
    const opener = createRef<HTMLButtonElement>();
    const fallback = createRef<HTMLHeadingElement>();
    const onOpenChange = vi.fn();
    const view = render(<><h1 ref={fallback} tabIndex={-1}>Work</h1><DeferredSheet item={null} open={false} onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    expect(moduleRequested).toBe(false);
    view.rerender(<><h1 ref={fallback} tabIndex={-1}>Work</h1><DeferredSheet item={null} itemId="task.A" isLoading open onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    expect(screen.getByRole("dialog", { name: "Loading work item" })).toBeInTheDocument();
    view.rerender(<><h1 ref={fallback} tabIndex={-1}>Work</h1><DeferredSheet item={null} open={false} onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    release?.();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.rerender(<><h1 ref={fallback} tabIndex={-1}>Work</h1><DeferredSheet item={{ ...item, id: "task.B", title: "Selected B" }} itemId="task.B" open onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    expect(await screen.findByRole("dialog", { name: "Selected B" })).toBeInTheDocument();
    expect(screen.queryByText("task.A")).toBeNull();
    vi.doUnmock("@/app/(app)/work/_components/WorkItemDetailBody");
  });

  it("contains a module failure in the dialog and leaves the list usable", async () => {
    vi.resetModules();
    let attempts = 0;
    vi.doMock("@/app/(app)/work/_components/WorkItemDetailBody", async () => { attempts += 1; throw new Error("detail chunk unavailable"); });
    const { WorkDetailSheet: BrokenSheet } = await import("@/app/(app)/work/_components/WorkDetailSheet");
    const reload = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Harness() {
      const [selected, setSelected] = useState<string | null>(null);
      const [filter, setFilter] = useState("task");
      const opener = useRef<HTMLButtonElement>(null);
      const fallback = useRef<HTMLHeadingElement>(null);
      return <><h1 ref={fallback} tabIndex={-1}>Work list</h1>
        <label>Filter <input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        <button ref={opener} type="button" onClick={() => setSelected("task.A")}>Open task A</button>
        <output>Filter: {filter}</output>
        <BrokenSheet item={null} itemId={selected ?? undefined} isLoading open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }} opener={opener} fallback={fallback} reload={reload} />
      </>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open task A" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load work item details");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open task A" })).toHaveFocus());
    fireEvent.change(screen.getByRole("textbox", { name: "Filter" }), { target: { value: "selected" } });
    expect(screen.getByText("Filter: selected")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open task A" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load work item details");
    expect(attempts).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Filter" })).toHaveValue("selected");
    expect(attempts).toBe(1);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/app/(app)/work/_components/WorkItemDetailBody");
  });
});
