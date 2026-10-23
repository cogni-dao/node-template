// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Covers exact-item cookie-auth fetches and the unknown-id error state. */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchWorkItem,
  fetchWorkItems,
  WorkItemFetchError,
} from "@/app/(app)/work/_api/fetchWorkItems";

describe("fetchWorkItem", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the encoded exact-item endpoint with same-origin auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "story.5000" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWorkItem("story.5000")).resolves.toMatchObject({
      id: "story.5000",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items/story.5000",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("surfaces unknown ids for the human not-found state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "Work item not found: bug.9999" }),
      }),
    );

    const error = await fetchWorkItem("bug.9999").catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkItemFetchError);
    expect(error).toMatchObject({
      message: "Work item not found: bug.9999",
      status: 404,
    });
  });

  it("keeps operational failures distinct from not-found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: "Work-item store is busy" }),
      }),
    );

    await expect(fetchWorkItem("task.5174")).rejects.toMatchObject({
      name: "WorkItemFetchError",
      message: "Work-item store is busy",
      status: 503,
    });
  });

  it("encodes a logical percent sequence once at the API boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "bug.%2F" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkItem("bug.%2F");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items/bug.%252F",
      expect.any(Object),
    );
  });
});

describe("fetchWorkItems complete client-sort input", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads evaluation fields beyond the first 500-item server page", async () => {
    const firstPage = Array.from({ length: 500 }, (_, i) => ({
      id: `task.${5000 + i}`,
      scores: { goal: { v: 1 } },
    }));
    const winner = { id: "task.9999", scores: { goal: { v: 5 } } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: firstPage,
          pageInfo: { endCursor: "next+/=", hasMore: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [winner],
          pageInfo: { endCursor: "finished", hasMore: false },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWorkItems();

    expect(result.items).toHaveLength(501);
    expect(result.items.at(-1)).toEqual(winner);
    expect(result.pageInfo?.hasMore).toBe(false);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/work/items?limit=500",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/work/items?limit=500&cursor=next%2B%2F%3D",
      expect.any(Object),
    );
  });

  it.each([null, "repeated"])(
    "rejects a non-advancing cursor (%s)",
    async (cursor) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            items: [],
            pageInfo: { endCursor: cursor, hasMore: true },
          }),
        }),
      );
      await expect(fetchWorkItems()).rejects.toThrow(
        "pagination did not advance",
      );
    },
  );

  it("rejects a failed later page instead of sorting a partial backlog", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            items: [{ id: "task.5000" }],
            pageInfo: { endCursor: "next", hasMore: true },
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => ({ error: "Work-item store is busy" }),
        }),
    );
    await expect(fetchWorkItems()).rejects.toThrow("Work-item store is busy");
  });
});
