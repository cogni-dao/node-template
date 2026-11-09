// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { buildNodeAiView, NODE_AI_COPY, type ToolRequires } from "../src";
import { memoryStore } from "./memory-store";

const perm = (scope: string, label: string): ToolRequires => ({
  scope, kind: "node", subject: "member", label,
});

describe("buildNodeAiView", () => {
  const permissionsByPrincipal = {
    "node-ai": [perm("knowledge:write", "Save notes"), perm("schedule:manage", "Change schedules"), perm("knowledge:write", "Save notes")],
    prioritizer: [perm("work_item:transition", "Update work items")],
  };

  it("lists one row per AI and permission, with the AI's plain name", () => {
    const rows = buildNodeAiView({ permissionsByPrincipal, liveRoles: [] });
    expect(rows.map((r) => [r.ai, r.permission])).toEqual([
      [NODE_AI_COPY["node-ai"]?.name, "Change schedules"],
      [NODE_AI_COPY["node-ai"]?.name, "Save notes"],
      [NODE_AI_COPY.prioritizer?.name, "Update work items"],
    ]);
    expect(rows.every((r) => r.allowed === false)).toBe(true);
  });

  it("marks only live (unrevoked) roles as allowed", async () => {
    const store = memoryStore({
      principals: { "node-ai": "u1", prioritizer: "u2" },
      roles: [{ principal: "u1", scope: "knowledge:write" }, { principal: "u2", scope: "work_item:transition", revoked: true }],
    });
    const rows = buildNodeAiView({ permissionsByPrincipal, liveRoles: await store.listLiveRoles() });
    expect(rows.find((r) => r.scope === "knowledge:write")?.allowed).toBe(true);
    expect(rows.find((r) => r.scope === "schedule:manage")?.allowed).toBe(false);
    expect(rows.find((r) => r.scope === "work_item:transition")?.allowed).toBe(false);
  });

  it("never shows the slug as a name, and skips a scope with no label", () => {
    const rows = buildNodeAiView({
      permissionsByPrincipal: { "some-new-ai": [perm("x:y", "Do a thing")], ghost: [{ scope: "a:b", kind: "node", subject: "member" }] },
      liveRoles: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ai).not.toBe("some-new-ai");
  });

  it("ships names with no id, token, scope string or path, and never the word job", () => {
    for (const c of Object.values(NODE_AI_COPY)) expect(c.name).not.toMatch(/[:/_]|http|token|curl|\bjobs?\b|[0-9a-f]{8}-/i);
  });
});
