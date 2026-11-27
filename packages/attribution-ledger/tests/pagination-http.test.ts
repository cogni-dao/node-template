// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it } from "vitest";
import { EPOCH_PRESENTATION_EVENTS, parseEpochPage } from "../src/http";

describe("epoch pagination input boundary", () => {
  it.each([
    "limit=bad",
    "limit=201",
    "limit=0",
    "offset=-1",
    "offset=nope",
  ])("refuses %s with safe metadata", (query) => {
    const result = parseEpochPage(
      new URLSearchParams(query),
      EPOCH_PRESENTATION_EVENTS.overview,
      { nodeId: "node" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.result).toMatchObject({
      status: 400,
      body: { error: "Invalid pagination", code: "INVALID_PAGINATION" },
      event: {
        event: EPOCH_PRESENTATION_EVENTS.overview,
        outcome: "refused",
        errorCode: "INVALID_PAGINATION",
        count: 0,
      },
    });
    expect(JSON.stringify(result)).not.toContain(query);
  });
  it("preserves defaults and valid bounds", () => {
    expect(
      parseEpochPage(new URLSearchParams(), EPOCH_PRESENTATION_EVENTS.summary, {
        nodeId: "node",
      })
    ).toMatchObject({ ok: true, page: { limit: 100, offset: 0 } });
    expect(
      parseEpochPage(
        new URLSearchParams("limit=200&offset=200"),
        EPOCH_PRESENTATION_EVENTS.receipts,
        { nodeId: "node" }
      )
    ).toMatchObject({ ok: true, page: { limit: 200, offset: 200 } });
  });
});
