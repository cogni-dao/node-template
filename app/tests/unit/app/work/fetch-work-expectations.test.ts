// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Covers the authenticated expectations read the app owns: one request, and HTTP errors surface. */

import { describe, expect, it, vi } from "vitest";

import { fetchWorkExpectations } from "@/app/(app)/work/_api/fetchWorkExpectations";

describe("fetchWorkExpectations", () => {
  it("reports an unavailable expectation projection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403 })),
    );
    try {
      await expect(
        fetchWorkExpectations("task.1", new AbortController().signal, []),
      ).rejects.toThrow("HTTP 403");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reads the bounded server projection in one request", async () => {
    const expected = {
      items: [
        {
          id: "hyp.1",
          title: "Expectation",
          content: "fresh reading",
          predictions: [
            { metricId: "m", expected: "gte 4 count", observed: "met" },
          ],
          outcomes: [
            {
              id: "outcome.1",
              title: "Observed",
              content: "independently recounted",
            },
          ],
          truncated: false,
        },
      ],
      truncated: false,
    };
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => expected,
    }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const page = await fetchWorkExpectations(
        "task.1",
        new AbortController().signal,
        [],
      );
      expect(page).toEqual(expected);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
