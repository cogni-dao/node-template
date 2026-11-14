// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/langgraph-graphs/tests/catalog-duties`
 * Purpose: The node operator learns recurring duties from catalog data, never from a duty named in its prompt.
 */

import { describe, expect, it } from "vitest";
import { NODE_LANGGRAPH_CATALOG } from "../src/catalog";
import { COORDINATOR_PROMPT } from "../src/graphs/coordinator/prompts";

describe("catalog duties", () => {
  it("lists each duty with its purpose, instruction and schedulability in the operator prompt", () => {
    const prompt = NODE_LANGGRAPH_CATALOG.cogni.systemPrompt;
    const listed = JSON.parse(prompt.slice(prompt.indexOf("[")));
    const triage = listed.find((w: { id: string }) => w.id === "langgraph:work-prioritizer");
    const closeout = listed.find((w: { id: string }) => w.id === "langgraph:work-closeout");
    expect(triage.duty.purpose).toBe("node-work-triage");
    expect(triage.duty.instruction).toContain("work-item-triage");
    expect(triage.schedulable).toBe(true);
    expect(closeout.duty.purpose).toBe("node-work-closeout");
    expect(closeout.schedulable).toBe(false);
  });

  it("names no specific duty in the operator prompt itself", () => {
    expect(COORDINATOR_PROMPT).not.toContain("node-work-triage");
    expect(COORDINATOR_PROMPT).not.toContain("langgraph:work-prioritizer");
  });
});
