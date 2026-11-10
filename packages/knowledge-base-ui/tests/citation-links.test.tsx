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
  ContributionCitationDiff,
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

describe("ContributionCitationDiff", () => {
  const citations: CitationDiffEdge[] = [
    {
      changeType: "added",
      citingId: "a-entry",
      citedId: "b-entry",
      citationType: "supports",
      context: "why a supports b",
    },
    {
      changeType: "added",
      citingId: "a-entry",
      citedId: "task.0059",
      citationType: "tracks",
      context: null,
    },
    {
      changeType: "removed",
      citingId: "c-entry",
      citedId: "b-entry",
      citationType: "extends",
      context: null,
    },
  ];
  const hrefFor = (id: string) =>
    id.startsWith("task.") ? `/work/${id}` : `/knowledge/${id}`;

  it("lists every changed edge under its citing entry with change, arrow, relation and slug", () => {
    render(<ContributionCitationDiff citations={citations} hrefFor={hrefFor} />);

    const section = screen.getByRole("region", { name: "Link changes" });
    expect(within(section).getByText("Links (3)")).toBeInTheDocument();
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);

    expect(
      within(section).getByRole("link", { name: "a-entry" }),
    ).toHaveAttribute("href", "/knowledge/a-entry");
    expect(
      within(section).getByRole("link", {
        name: "added outgoing tracks task.0059",
      }),
    ).toHaveAttribute("href", "/work/task.0059");
    expect(
      within(section).getByRole("link", {
        name: "added outgoing supports b-entry",
      }),
    ).toHaveAttribute("title", "why a supports b");
    expect(
      within(section).getByRole("link", {
        name: "removed outgoing extends b-entry",
      }),
    ).toHaveAttribute("href", "/knowledge/b-entry");
  });

  it("marks a re-contexted edge as changed and keeps its context on hover", () => {
    render(
      <ContributionCitationDiff
        citations={[
          {
            changeType: "modified",
            citingId: "a-entry",
            citedId: "b-entry",
            citationType: "extends",
            context: "new why",
          },
        ]}
        hrefFor={hrefFor}
      />,
    );

    expect(
      screen.getByRole("link", { name: "changed outgoing extends b-entry" }),
    ).toHaveAttribute("title", "new why");
  });

  it("renders nothing when the inbox changes no edges", () => {
    const { container } = render(
      <ContributionCitationDiff citations={[]} hrefFor={hrefFor} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
