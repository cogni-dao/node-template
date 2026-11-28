// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, log } = vi.hoisted(() => ({
  store: {
    getEpoch: vi.fn(),
    getCurrentEpoch: vi.fn(),
    listEpochHistoryPage: vi.fn(),
  },
  log: { info: vi.fn() },
}));
vi.mock("@cogni/node-contracts", () => ({
  listEpochsOperation: {},
  epochActivityOperation: {},
  epochUserProjectionsOperation: {},
  epochClaimantsOperation: {},
}));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {},
  logEvent: vi.fn(),
}));
vi.mock("@/app/_facades/attribution/claimants.server", () => ({
  readFinalizedEpochClaimants: vi.fn(),
}));
vi.mock("@/app/api/v1/public/attribution/_lib/attribution-dto", () => ({
  toUserProjectionDto: vi.fn(),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ attributionStore: store }),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => "node-1" }));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: unknown,
        request: Request,
        user: unknown,
        context: unknown
      ) => Promise<Response>
    ) =>
    (request: Request, context: unknown) =>
      handler({ log }, request, {}, context),
}));

import { GET as activity } from "@/app/api/v1/attribution/epochs/[id]/activity/route";
import { GET as claimants } from "@/app/api/v1/attribution/epochs/[id]/claimants/route";
import { GET as projections } from "@/app/api/v1/attribution/epochs/[id]/user-projections/route";
import { GET as overview } from "@/app/api/v1/attribution/epochs/route";

describe("attribution route pagination", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ["overview", overview, "view=overview&limit=bad"],
    ["activity", activity, "limit=bad"],
    ["contributor detail", activity, "claimantKey=user%3A1&offset=-1"],
    ["projection summary", projections, "view=summary&limit=bad"],
    ["claimant summary", claimants, "view=summary&limit=bad"],
  ])("%s refuses malformed input before reading", async (_name, handler, query) => {
    const response = await handler(
      new Request(`http://localhost/api?${query}`) as never,
      { params: Promise.resolve({ id: "1" }) } as never
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid pagination",
      code: "INVALID_PAGINATION",
    });
    expect(store.getEpoch).not.toHaveBeenCalled();
    expect(store.getCurrentEpoch).not.toHaveBeenCalled();
    expect(store.listEpochHistoryPage).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "refused",
        errorCode: "INVALID_PAGINATION",
      }),
      expect.any(String)
    );
  });
  it("keeps valid overview and propagates store failure", async () => {
    store.getCurrentEpoch
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("store failed"));
    store.listEpochHistoryPage.mockResolvedValue({ epochs: [], total: 0 });
    const response = await overview(
      new Request("http://localhost/api?view=overview") as never,
      {} as never
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      current: null,
      epochs: [],
      total: 0,
    });
    await expect(
      overview(
        new Request("http://localhost/api?view=overview") as never,
        {} as never
      )
    ).rejects.toThrow("store failed");
  });
});
