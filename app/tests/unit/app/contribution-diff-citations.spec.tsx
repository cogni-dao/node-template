// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/contribution-diff-citations`
 * Purpose: Prove the inbox diff lists citation edges and never calls an edge-only inbox empty.
 * Scope: ContributionDiff over a stubbed diff response. Does not use a live network.
 * Invariants: CITATION_DIFF_FOR_REVIEW, EVERY_DIFF_EDGE_LISTED.
 * Side-effects: global (stubbed fetch)
 * Links: bug.0011
 * @vitest-environment jsdom
 * @internal
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContributionDiff } from "@/app/(app)/knowledge/_components/ContributionDiff";

vi.mock("@/components", () => ({
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function respond(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body))
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ContributionDiff citations", () => {
  it("lists every edge of an edge-only inbox and never says no changes", async () => {
    respond({
      contributionId: "contrib-1",
      branch: "contrib/1",
      entries: [],
      citations: [
        {
          changeType: "added",
          citingId: "a-entry",
          citedId: "task.0059",
          citationType: "tracks",
          context: null,
        },
        {
          changeType: "removed",
          citingId: "a-entry",
          citedId: "b-entry",
          citationType: "supports",
          context: "old",
        },
      ],
    });
    render(<ContributionDiff contributionId="contrib-1" />);

    const section = await screen.findByRole("region", { name: "Link changes" });
    expect(within(section).getByText("Links (2)")).toBeTruthy();
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(section).getByRole("link", { name: "task.0059" }).getAttribute("href")
    ).toBe("/work/items/task.0059");
    expect(
      within(section).getByRole("link", { name: "b-entry" }).getAttribute("href")
    ).toBe("/knowledge/b-entry");
    expect(screen.queryByText(/No changes detected/)).toBeNull();
  });

  it("says no changes only when neither rows nor edges changed", async () => {
    respond({ contributionId: "c", branch: "b", entries: [], citations: [] });
    render(<ContributionDiff contributionId="c" />);

    await screen.findByText("No changes detected.");
    expect(screen.queryByRole("region", { name: "Link changes" })).toBeNull();
  });

  it("treats a server without citations as no edge changes", async () => {
    respond({ contributionId: "c", branch: "b", entries: [] });
    render(<ContributionDiff contributionId="c" />);

    await screen.findByText("No changes detected.");
  });
});
