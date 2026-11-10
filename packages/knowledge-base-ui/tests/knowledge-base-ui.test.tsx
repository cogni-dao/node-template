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
    const safe = document.querySelector("#safe");
    expect(safe?.getAttribute("href")).toBe(
      "https://node.example/knowledge/core"
    );
    expect(safe?.getAttribute("target")).toBe("_top");
    expect(safe?.getAttribute("rel")).toBe("noopener noreferrer");

    const unsafe = document.querySelector("#unsafe");
    expect(unsafe?.hasAttribute("href")).toBe(false);
    expect(unsafe?.hasAttribute("target")).toBe(false);
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

  it("inserts each iframe with its final srcdoc and never mutates it", () => {
    const inserted: string[] = [];
    const srcdocWrites: string[] = [];
    const collect = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === "attributes") srcdocWrites.push(record.oldValue ?? "");
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          const frames = node.matches("iframe")
            ? [node]
            : [...node.querySelectorAll("iframe")];
          for (const frame of frames) {
            inserted.push(frame.getAttribute("srcdoc") ?? "");
          }
        });
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributeFilter: ["srcdoc"],
    });

    const { rerender } = render(
      <KnowledgeHtmlFrame documentHtml="<p>light</p>" title="Visual" />
    );
    rerender(<KnowledgeHtmlFrame documentHtml="<p>dark</p>" title="Visual" />);
    rerender(<KnowledgeHtmlFrame documentHtml="" title="Visual" />);
    rerender(<KnowledgeHtmlFrame documentHtml="<p>again</p>" title="Visual" />);
    collect(observer.takeRecords());
    observer.disconnect();

    expect(srcdocWrites).toHaveLength(0);
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.every((srcdoc) => srcdoc.includes("<p>"))).toBe(true);
    expect(screen.getByTitle("Visual").getAttribute("srcdoc")).toContain(
      "again"
    );
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
