// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Covers open, close, and browser-back semantics for work-item permalinks. */

import { describe, expect, it, vi } from "vitest";

import {
  closeWorkItemPermalink,
  openWorkItemPermalink,
  workItemHref,
  workListHref,
} from "@/app/(app)/work/_lib/workItemNavigation";

const searchParams = new URLSearchParams(
  "status=needs_implement&sort=priority&q=permalink"
);

describe("work-item permalink navigation", () => {
  it("builds exact human routes while preserving useful list state", () => {
    expect(workItemHref("subtask.5001", searchParams)).toBe(
      "/work/subtask.5001?status=needs_implement&sort=priority&q=permalink"
    );
    expect(workListHref(searchParams)).toBe(
      "/work?status=needs_implement&sort=priority&q=permalink"
    );
  });

  it("pushes selection so browser Back returns to the list", () => {
    const router = { push: vi.fn(), replace: vi.fn() };

    openWorkItemPermalink(router, "story.5000", searchParams);

    expect(router.push).toHaveBeenCalledWith(
      "/work/story.5000?status=needs_implement&sort=priority&q=permalink",
      { scroll: false }
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("replaces a closed sheet with its preserved list URL", () => {
    const router = { push: vi.fn(), replace: vi.fn() };

    closeWorkItemPermalink(router, searchParams);

    expect(router.replace).toHaveBeenCalledWith(
      "/work?status=needs_implement&sort=priority&q=permalink",
      { scroll: false }
    );
    expect(router.push).not.toHaveBeenCalled();
  });
});
