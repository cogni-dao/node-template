// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  formatCitationLabel,
  KNOWLEDGE_HTML_SANDBOX,
  KnowledgeHtmlFrame,
  normalizeKnowledgeHtmlNavigation,
} from "../src/index.js";

describe("knowledge-base-ui", () => {
  it("normalizes safe links and disables unsafe protocols", () => {
    const html = normalizeKnowledgeHtmlNavigation(
      '<base href="https://attacker.example/"><a id="safe" href="/knowledge/core" target="_self">safe</a><a id="unsafe" href="javascript:alert(1)">unsafe</a>',
      "https://node.example/knowledge/current"
    );
    const document = new DOMParser().parseFromString(html, "text/html");

    expect(document.querySelector("base")).toBeNull();
    expect(document.querySelector("#safe")).toHaveAttribute(
      "href",
      "https://node.example/knowledge/core"
    );
    expect(document.querySelector("#safe")).toHaveAttribute("target", "_top");
    expect(document.querySelector("#safe")).toHaveAttribute(
      "rel",
      "noopener noreferrer"
    );
    expect(document.querySelector("#unsafe")).not.toHaveAttribute("href");
    expect(document.querySelector("#unsafe")).not.toHaveAttribute("target");
  });

  it("owns the iframe sandbox and normalized document", async () => {
    render(
      <KnowledgeHtmlFrame
        documentHtml='<a href="https://example.com/design">design</a>'
        title="Knowledge visual"
      />
    );

    const iframe = screen.getByTitle("Knowledge visual");
    expect(iframe).toHaveAttribute("sandbox", KNOWLEDGE_HTML_SANDBOX);
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    await waitFor(() => expect(iframe).toHaveAttribute("aria-busy", "false"));
    expect(iframe.getAttribute("srcdoc")).toContain('target="_top"');
  });

  it("prefers citation titles and falls back to ids", () => {
    expect(
      formatCitationLabel("supports", { id: "entry-slug", title: "Human title" })
    ).toBe("supports Human title");
    expect(formatCitationLabel("supports", { id: "entry-slug" })).toBe(
      "supports entry-slug"
    );
  });
});
