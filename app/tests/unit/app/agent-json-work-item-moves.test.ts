// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/agent-json-work-item-moves`
 * Purpose: The agent manifest lets an agent set `moves` on a work item and shows it on the read (story.0033).
 * Scope: `GET /.well-known/agent.json` over the typed contracts. No database.
 * Invariants:
 *   - SCHEMA_IS_THE_CONTRACT: the manifest's PATCH `set.moves` schema comes from the shared patch schema (at most 3 of { metricId, direction }); it offers no baseline.
 *   - READ_SHOWS_THE_BASELINE: the GET output schema carries the pinned baseline and the read-time fields.
 * Side-effects: none
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BUILD_SHA: "test-sha" }),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeBrandColor: () => "#000000",
  getNodeBrandIcon: () => "circle",
  getNodeHook: () => "Test hook",
  getNodeMission: () => "Test mission",
  getNodeName: () => "Test node",
  getNodeThumbnail: () => null,
}));

describe("agent.json work-item moves", () => {
  it("offers moves on the create and PATCH actions, without a baseline, and shows it on the read", async () => {
    const { GET } = await import("@/app/.well-known/agent.json/route");
    const body = await (
      await GET(new Request("https://node.example/.well-known/agent.json"))
    ).json();

    const moves =
      body.actions.updateWorkItem.inputSchema.properties.set.properties.moves;
    expect(moves).toMatchObject({ type: "array", maxItems: 3 });
    expect(moves.description).toContain("never send one");
    expect(moves.items.required).toEqual(["metricId", "direction"]);
    expect(moves.items.properties.metricId).toMatchObject({
      minLength: 1,
      maxLength: 40,
    });
    expect(moves.items.properties.direction.anyOf.find((variant: { enum?: unknown }) => variant.enum)?.enum).toEqual(["up", "down"]);
    expect(moves.items.properties.direction.anyOf).toContainEqual({ type: "null" });
    expect(moves.items.properties.direction.description).toContain("storage writes remain disabled");
    expect(moves.items.properties).not.toHaveProperty("baselineObservationId");

    // A create names its metrics at filing time with the same schema.
    const onCreate =
      body.actions.createWorkItem.inputSchema.properties.moves;
    expect(onCreate).toMatchObject({ type: "array", maxItems: 3 });
    expect(onCreate.description).toContain("never send one");
    expect(onCreate.items.properties).not.toHaveProperty(
      "baselineObservationId"
    );

    const read =
      body.actions.getWorkItem.outputSchema.properties.moves.items.properties;
    expect(read).toHaveProperty("baselineObservationId");
    expect(read.moved.anyOf.find((variant: { enum?: unknown }) => variant.enum)?.enum).toEqual([
      "as_declared",
      "against",
      "flat",
      "unknown",
    ]);
    expect(read.moved.anyOf).toContainEqual({ type: "null" });
    expect(read.unknownReason.enum).toContain("metric_deprecated");
  });
});
