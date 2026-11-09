// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalFragmentScrub, shouldScrubApprovalFragment } from "../src/index.js";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("ApprovalFragmentScrub", () => {
  it("removes #agent-request= on a non-profile path, keeping path and query", () => {
    window.history.replaceState(null, "", "/chat?thread=7#agent-request=abc123");
    render(<ApprovalFragmentScrub />);
    expect(window.location.hash).toBe("");
    expect(window.location.pathname + window.location.search).toBe("/chat?thread=7");
  });

  it("leaves an #attestation= fragment untouched", () => {
    window.history.replaceState(null, "", "/chat#attestation=eyJ");
    render(<ApprovalFragmentScrub />);
    expect(window.location.hash).toBe("#attestation=eyJ");
  });

  it("leaves #agent-request= alone on /profile (the page reads and removes it itself)", () => {
    window.history.replaceState(null, "", "/profile#agent-request=abc123");
    render(<ApprovalFragmentScrub />);
    expect(window.location.hash).toBe("#agent-request=abc123");
  });

  it("is a no-op with no fragment", () => {
    window.history.replaceState(null, "", "/chat");
    render(<ApprovalFragmentScrub />);
    expect(window.location.pathname).toBe("/chat");
  });

  it("states the rule purely", () => {
    expect(shouldScrubApprovalFragment({ pathname: "/", hash: "#agent-request=x" })).toBe(true);
    expect(shouldScrubApprovalFragment({ pathname: "/profile", hash: "#agent-request=x" })).toBe(false);
    expect(shouldScrubApprovalFragment({ pathname: "/chat", hash: "#attestation=x" })).toBe(false);
  });
});

describe("ApprovalFragmentScrub (strength)", () => {
  it("keeps history state, removes the fragment exactly once, and does nothing on re-render", () => {
    window.history.replaceState({ k: 1 }, "", "/chat#agent-request=abc");
    const calls: unknown[][] = [];
    const real = window.history.replaceState.bind(window.history);
    window.history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
      calls.push(args);
      return real(...args);
    }) as History["replaceState"];
    try {
      const { rerender } = render(<ApprovalFragmentScrub />);
      rerender(<ApprovalFragmentScrub />);
    } finally {
      window.history.replaceState = real;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({ k: 1 });
    expect(calls[0]?.[2]).toBe("/chat");
    expect(window.location.hash).toBe("");
  });

  it("leaves a plain no-fragment URL untouched (no replaceState call)", () => {
    window.history.replaceState(null, "", "/chat?x=1");
    let called = false;
    const real = window.history.replaceState.bind(window.history);
    window.history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
      called = true;
      return real(...args);
    }) as History["replaceState"];
    try {
      render(<ApprovalFragmentScrub />);
    } finally {
      window.history.replaceState = real;
    }
    expect(called).toBe(false);
  });
});
