// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { buildNodeAiView, NODE_AI_COPY, type ToolRequires } from "../src";
import { memoryStore } from "./memory-store";

const job = (scope: string, label: string, risk: "low" | "medium" | "high" = "medium"): ToolRequires => ({
  scope, kind: "node", subject: "member", label, risk,
});

describe("buildNodeAiView", () => {
  const jobsByPrincipal = {
    "node-ai": [job("knowledge:write", "Save notes", "medium"), job("schedule:manage", "Change schedules", "high"), job("knowledge:write", "Save notes", "medium")],
    prioritizer: [job("work_item:transition", "Update work items", "medium")],
  };

  it("lists each AI with plain-language copy and its jobs, riskiest first, one row per scope", () => {
    const view = buildNodeAiView({ jobsByPrincipal, liveRoles: [] });
    expect(view.map((v) => v.name)).toEqual([NODE_AI_COPY["node-ai"]?.name, NODE_AI_COPY.prioritizer?.name]);
    expect(view[0]?.jobs.map((j) => j.label)).toEqual(["Change schedules", "Save notes"]);
    expect(view.flatMap((v) => v.jobs).every((j) => j.allowed === false)).toBe(true);
  });

  it("marks only live (unrevoked) roles as allowed", async () => {
    const store = memoryStore({
      principals: { "node-ai": "u1", prioritizer: "u2" },
      roles: [{ principal: "u1", scope: "knowledge:write" }, { principal: "u2", scope: "work_item:transition", revoked: true }],
    });
    const view = buildNodeAiView({ jobsByPrincipal, liveRoles: await store.listLiveRoles() });
    expect(view[0]?.jobs.find((j) => j.scope === "knowledge:write")?.allowed).toBe(true);
    expect(view[0]?.jobs.find((j) => j.scope === "schedule:manage")?.allowed).toBe(false);
    expect(view[1]?.jobs[0]?.allowed).toBe(false);
  });

  it("never shows the slug as a name, and skips a scope with no label", () => {
    const view = buildNodeAiView({
      jobsByPrincipal: { "some-new-ai": [job("x:y", "Do a thing")], ghost: [{ scope: "a:b", kind: "node", subject: "member" }] },
      liveRoles: [],
    });
    expect(view).toHaveLength(1);
    expect(view[0]?.name).not.toBe("some-new-ai");
  });

  it("ships copy and labels with no id, token, scope string or path", () => {
    for (const c of Object.values(NODE_AI_COPY)) expect(`${c.name} ${c.blurb}`).not.toMatch(/[:/_]|http|token|curl|[0-9a-f]{8}-/i);
  });
});
