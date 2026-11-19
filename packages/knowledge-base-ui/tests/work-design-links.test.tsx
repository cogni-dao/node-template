// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/tests/work-design-links`
 * Purpose: Prove a work item's typed design links draw as `→ design <id>` rows that open the atom, and an old untyped entry stays visible as text (story.0069).
 * Scope: Shared React component with an injected href. No network.
 * Invariants: ONE_ROW_RENDERER, ONE_EMPTY_STATE, ROADMAP_FIRST.
 * Side-effects: global (React test DOM)
 * @internal
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkDesignLinks } from "../src/index.js";

afterEach(cleanup);

describe("WorkDesignLinks", () => {
  it("draws each typed link as a design row to the atom and keeps an untyped entry as text", () => {
    render(
      <WorkDesignLinks
        specRefs={["knowledge:node-sandbox-design", "https://github.com/cogni-dao/node-template/pull/255"]}
        hrefFor={(id) => `/hub/${id}`}
      />,
    );
    expect(screen.getByRole("region", { name: "Design" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "design node-sandbox-design" });
    expect(link).toHaveAttribute("href", "/hub/node-sandbox-design");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("https://github.com/cogni-dao/node-template/pull/255")).toBeInTheDocument();
  });

  it("puts the roadmap first, then the design, each its own row", () => {
    render(<WorkDesignLinks specRefs={["knowledge:node-sandbox-design"]} roadmapIds={["roadmap-ai-work-converges"]} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual([
      "roadmap roadmap-ai-work-converges",
      "design node-sandbox-design",
    ]);
  });

  it("says nothing is linked yet, in the one empty state every section uses", () => {
    render(<WorkDesignLinks specRefs={[]} />);
    expect(screen.getByRole("region", { name: "Design" })).toHaveTextContent("No design linked yet");
  });
});
