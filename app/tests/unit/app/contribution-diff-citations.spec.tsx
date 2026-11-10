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
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
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
      within(section).getByRole("link", { name: "added outgoing tracks task.0059" }).getAttribute("href")
    ).toBe("/work/items/task.0059");
    expect(
      within(section).getByRole("link", { name: "removed outgoing supports b-entry" }).getAttribute("href")
    ).toBe("/knowledge/b-entry");
    expect(screen.queryByText(/No changes detected/)).toBeNull();
  });

  it("lists only confidence-only rows compactly; any other change stays a card", async () => {
    const row = {
      id: "agent-development",
      title: "Add an agent graph",
      content: "Unchanged body",
      useWhen: null,
      metricSpec: null,
      kpiBindings: null,
      entryType: "guide",
      domain: "build-agents",
    };
    respond({
      contributionId: "c",
      branch: "b",
      entries: [
        {
          changeType: "modified",
          rowId: "agent-development",
          before: { ...row, confidencePct: 40 },
          after: { ...row, confidencePct: 55 },
          changedFields: ["confidencePct"],
        },
        {
          changeType: "modified",
          rowId: "tagged-entry",
          before: { ...row, id: "tagged-entry", confidencePct: 40 },
          after: { ...row, id: "tagged-entry", content: "Tagged body", confidencePct: 55 },
          changedFields: ["confidencePct", "tags"],
        },
      ],
      citations: [
        {
          changeType: "added",
          citingId: "frontend-development",
          citedId: "agent-development",
          citationType: "extends",
          context: null,
        },
      ],
    });
    render(<ContributionDiff contributionId="c" />);

    const recomputed = await screen.findByRole("region", {
      name: "Confidence recomputed",
    });
    expect(within(recomputed).getByText("40% → 55%")).toBeTruthy();
    expect(within(recomputed).queryByText("tagged-entry")).toBeNull();
    expect(screen.queryByText("Unchanged body")).toBeNull();
    // A confidence change plus any authored column stays a full edited card.
    expect(screen.getAllByText("modified")).toHaveLength(1);
    expect(screen.getByText("Tagged body")).toBeTruthy();
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
