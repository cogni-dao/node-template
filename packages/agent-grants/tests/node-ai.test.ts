// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { buildNodeAiView } from "../src";
import { memoryStore } from "./memory-store";

const declarations = {
  "knowledge:write": { label: "Save notes", description: "Write notes into this node's knowledge base." },
  "schedule:manage": { label: "Change schedules", description: "Make and change schedules for the person it helps." },
  "work_item:transition": { label: "Update work items", description: "Change work items and their priority scores." },
};
const internal = [
  { userId: "u1", slug: "node-ai", displayName: "General assistant" },
  { userId: "u2", slug: "prioritizer", displayName: null },
];
const scopesByPrincipal = {
  "node-ai": ["knowledge:write", "schedule:manage", "knowledge:write"],
  prioritizer: ["work_item:transition"],
};
const build = async (store: ReturnType<typeof memoryStore>) =>
  buildNodeAiView({ declarations, scopesByPrincipal, internal, rows: (await store.listRoleRows(100)).rows });

describe("buildNodeAiView: one row per grant row, in three blocks", () => {
  it("lists each internal AI by each permission, name and description from the declaration, name from agent_principals", async () => {
    const rows = await build(memoryStore({ principals: { "node-ai": "u1", prioritizer: "u2" } }));
    expect(rows.every((r) => r.section === "node" && r.on === false && r.until === null && !r.outside)).toBe(true);
    expect(rows.map((r) => [r.who, r.label, r.description.length > 0])).toEqual([
      ["General assistant", "Change schedules", true],
      ["General assistant", "Save notes", true],
      ["Node AI", "Update work items", true], // no display name: a neutral name, never the slug
    ]);
  });

  it("marks only live (approved, unrevoked) rows on", async () => {
    const rows = await build(
      memoryStore({
        principals: { "node-ai": "u1", prioritizer: "u2" },
        roles: [{ principal: "u1", scope: "knowledge:write" }, { principal: "u2", scope: "work_item:transition", revoked: true }],
      })
    );
    expect(rows.find((r) => r.scope === "knowledge:write")?.on).toBe(true);
    expect(rows.find((r) => r.scope === "work_item:transition")?.on).toBe(false);
  });

  it("puts a pending ask in the asks block (off), once, for an internal AI or an outside agent", async () => {
    const rows = await build(
      memoryStore({
        principals: { "node-ai": "u1", prioritizer: "u2" },
        names: { "ext-1": "Helper bot", "node-ai": "General assistant" },
        roles: [
          { principal: "u1", scope: "knowledge:write", pending: true },
          { principal: "ext-1", scope: "work_item:transition", pending: true },
        ],
      })
    );
    const pending = rows.filter((r) => r.section === "pending");
    expect(pending.map((r) => [r.who, r.outside, r.on])).toEqual([["General assistant", false, false], ["Helper bot", true, false]]);
    expect(rows.filter((r) => r.section === "node" && r.scope === "knowledge:write")).toEqual([]); // not shown twice
  });

  it("lists a live outside agent in its own block, on, with the outside marker", async () => {
    const rows = await build(memoryStore({ principals: { "node-ai": "u1" }, names: { "ext-1": "Helper bot" }, roles: [{ principal: "ext-1", scope: "work_item:transition" }] }));
    expect(rows.filter((r) => r.section === "outside")).toEqual([
      expect.objectContaining({ who: "Helper bot", outside: true, on: true, label: "Update work items" }),
    ]);
  });

  it("skips a scope with no declaration, names an unnamed agent neutrally, and never shows a slug-like or scope text", async () => {
    const rows = await build(memoryStore({ principals: { "node-ai": "u1" }, roles: [{ principal: "ext-2", scope: "made:up", pending: true }, { principal: "ext-2", scope: "knowledge:write", pending: true }] }));
    expect(rows.some((r) => r.scope === "made:up")).toBe(false);
    expect(rows.find((r) => r.principalUserId === "ext-2")?.who).toBe("Unnamed agent");
    const text = JSON.stringify(rows.map((r) => [r.who, r.label, r.description, r.hint]));
    expect(text).not.toMatch(/:|\/api\/|token|curl|\bjobs?\b/i);
  });
});
