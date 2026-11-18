// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/tests/work-pull-links`
 * Purpose: Prove an item's PRs read as owner/repo#N only for a real GitHub pull URL, and that only https URLs become links (story.0069).
 * Scope: Helpers and the component with no network.
 * Invariants: MANY_PRS, HTTPS_ONLY_LINKS.
 * Side-effects: none
 * @internal
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { pullLabel, pullUrls, WorkPullLinks } from "../src/index.js";

afterEach(cleanup);

describe("work pull links", () => {
  it("labels only a github.com pull URL, so another host cannot borrow a PR name", () => {
    expect(pullLabel("https://github.com/cogni-dao/node-template/pull/425")).toBe("cogni-dao/node-template#425");
    expect(pullLabel("https://example.test/x?github.com/a/b/pull/1")).toBe("https://example.test/x?github.com/a/b/pull/1");
  });

  it("lists pr first, then each other https PR once, and never a javascript: link", () => {
    expect(
      pullUrls("https://github.com/a/b/pull/1", [
        { kind: "pr", url: "https://github.com/a/c/pull/2" },
        { kind: "pr", url: "https://github.com/a/b/pull/1" },
        { kind: "pr", url: "javascript:alert(1)" },
        { kind: "issue", url: "https://github.com/a/b/issues/3" },
      ]),
    ).toEqual(["https://github.com/a/b/pull/1", "https://github.com/a/c/pull/2"]);
    expect(pullUrls(null, [])).toEqual([]);
  });

  it("keeps a pr that is not an https URL visible as text, not a link", () => {
    render(<WorkPullLinks pr="branch-only-deliverable" externalRefs={[]} />);
    expect(screen.getByText("branch-only-deliverable")).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
