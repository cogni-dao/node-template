// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Proves every open work-item sheet state is named and described. */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import type { WorkItemDto } from "@cogni/node-contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
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

afterEach(() => {
  cleanup();
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
    vi.doMock("@/app/(app)/work/_components/WorkItemDetailBody", async () => { throw new Error("detail chunk unavailable"); });
    const { WorkDetailSheet: BrokenSheet } = await import("@/app/(app)/work/_components/WorkDetailSheet");
    const opener = createRef<HTMLButtonElement>();
    const fallback = createRef<HTMLHeadingElement>();
    const onOpenChange = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<><h1 ref={fallback} tabIndex={-1}>Work list</h1><BrokenSheet item={null} itemId="task.A" isLoading open onOpenChange={onOpenChange} opener={opener} fallback={fallback} /></>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load work item details");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reload page" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByText("Work list")).toBeInTheDocument();
    vi.doUnmock("@/app/(app)/work/_components/WorkItemDetailBody");
  });
});
