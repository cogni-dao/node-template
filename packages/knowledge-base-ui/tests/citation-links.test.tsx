// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/tests/citation-links`
 * Purpose: Prove citation rows show direction, relation and slug, never inline titles,
 *   and that an inbox lists every changed edge.
 * Scope: Shared React components with injected loaders and hrefs. No network.
 * Invariants: SLUG_NOT_TITLE, DIRECTION_VISIBLE, EVERY_DIFF_EDGE_LISTED.
 * Side-effects: global (React test DOM)
 * @internal
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CitationDiffEdge,
  type CitationLink,
  CitationLinks,
  CitationEdgeList,
  groupContributionChanges,
} from "../src/index.js";

afterEach(cleanup);

const root = { id: "root-entry", title: "Root entry", href: "/knowledge/root-entry" };

function edge(
  direction: "out" | "in",
  citationType: string,
  other: { id: string; title: string | null },
): CitationLink {
  const endpoint = { ...other, href: `/knowledge/${other.id}` };
  return {
    id: `${direction}:${citationType}:${other.id}`,
    direction,
    citationType,
    source: direction === "out" ? root : endpoint,
    target: direction === "out" ? endpoint : root,
    context: null,
  };
}

describe("CitationLinks", () => {
  it("renders arrow, relation and slug per edge, with the title only on hover", async () => {
    const loadPage = vi.fn(async () => ({
      links: [
        edge("out", "supports", {
          id: "dao-goals-design",
          title: "Goals live in the hub and agents read them first",
        }),
        edge("in", "tracks", { id: "task.0059", title: "Knowledge browse ships" }),
      ],
      nextCursor: null,
    }));
    render(<CitationLinks entityId="root-entry" loadPage={loadPage} />);

    const out = await screen.findByRole("link", {
      name: "outgoing supports dao-goals-design",
    });
    expect(out).toHaveAttribute("href", "/knowledge/dao-goals-design");
    expect(out).toHaveAttribute(
      "title",
      "Goals live in the hub and agents read them first",
    );
    expect(
      screen.queryByText(/Goals live in the hub/),
    ).not.toBeInTheDocument();

    expect(within(out).getByText("→")).toBeInTheDocument();

    const incoming = screen.getByRole("link", {
      name: "incoming tracks task.0059",
    });
    expect(incoming).toHaveAttribute("href", "/knowledge/task.0059");
    expect(within(incoming).getByText("←")).toBeInTheDocument();
  });

  it("reads the incoming side from the definition label, not the raw type", async () => {
    const loadPage = vi.fn(async () => ({
      links: [
        {
          ...edge("in", "supports", { id: "work-item-triage", title: null }),
          label: "supported by",
          tone: "positive" as const,
        },
      ],
      nextCursor: null,
    }));
    render(<CitationLinks entityId="root-entry" loadPage={loadPage} />);

    const row = await screen.findByRole("link", {
      name: "incoming supported by work-item-triage",
    });
    expect(within(row).getByText("supported by")).toBeInTheDocument();
    expect(within(row).queryByText("supports")).toBeNull();
  });

  it("falls back to the slug for hover when an endpoint has no title", async () => {
    const loadPage = vi.fn(async () => ({
      links: [edge("out", "extends", { id: "no-title", title: null })],
      nextCursor: null,
    }));
    render(<CitationLinks entityId="root-entry" loadPage={loadPage} />);

    expect(
      await screen.findByRole("link", { name: /no-title$/ }),
    ).toHaveAttribute("title", "no-title");
  });
});

describe("groupContributionChanges", () => {
  const row = (rowId: string, changedFields?: string[], from = 30, to = 30) => ({
    changeType: "modified" as const,
    rowId,
    before: { title: rowId, confidencePct: from },
    after: { title: rowId, confidencePct: to },
    ...(changedFields ? { changedFields } : {}),
  });
  const edge = (citingId: string, citedId: string): CitationDiffEdge => ({
    changeType: "added",
    citingId,
    citedId,
    citationType: "extends",
    context: null,
  });

  it("gives each entry one record: authored, then link-only, then confidence-only", () => {
    const changes = groupContributionChanges(
      [
        row("cited", ["confidencePct"], 30, 60),
        row("edited", ["confidencePct", "useWhen"], 30, 40),
      ],
      [edge("citer", "cited"), edge("edited", "cited")]
    );

    expect(changes.map((c) => [c.rowId, c.authored, c.edges.length])).toEqual([
      ["edited", true, 1],
      ["citer", false, 1],
      ["cited", false, 0],
    ]);
    expect(changes[0]?.confidence).toEqual({ from: 30, to: 40 });
    expect(changes[2]?.confidence).toEqual({ from: 30, to: 60 });
    expect(changes[1]?.entry).toBeNull();
  });

  it("treats a modified row without changedFields as authored", () => {
    const [change] = groupContributionChanges([row("old-server")], []);
    expect(change?.authored).toBe(true);
    expect(change?.confidence).toBeNull();
  });
});

describe("CitationEdgeList", () => {
  const hrefFor = (id: string) =>
    id.startsWith("task.") ? `/work/${id}` : `/knowledge/${id}`;

  it("lists one entry's link changes with change, arrow, relation and slug", () => {
    render(
      <CitationEdgeList
        edges={[
          { changeType: "added", citingId: "a", citedId: "task.0059", citationType: "tracks", context: null },
          { changeType: "removed", citingId: "a", citedId: "b-entry", citationType: "extends", context: "old why" },
          { changeType: "modified", citingId: "a", citedId: "c-entry", citationType: "supports", context: "new why" },
        ]}
        hrefFor={hrefFor}
      />
    );

    const list = screen.getByRole("list", { name: "Link changes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(
      screen.getByRole("link", { name: "added link: a tracks task.0059" })
    ).toHaveAttribute("href", "/work/task.0059");
    expect(
      screen.getByRole("link", { name: "removed link: a extends b-entry" })
    ).toHaveAttribute("title", "old why");
    expect(
      screen.getByRole("link", { name: "changed link: a supports c-entry" })
    ).toHaveAttribute("title", "new why");
  });

  it("renders nothing for an entry with no link changes", () => {
    const { container } = render(<CitationEdgeList edges={[]} hrefFor={hrefFor} />);
    expect(container).toBeEmptyDOMElement();
  });
});
