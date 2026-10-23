// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `tests/contract/app/knowledge.analytics`
 * Purpose: Prove authenticated API collection, unavailable-source semantics and single admission.
 * Scope: Targeted tests with injected sources; no external services.
 * Invariants: UNKNOWN_IS_NOT_ZERO; AUTH_BEFORE_READS.
 * Side-effects: none outside the test process.
 * Links: https://cognidao.org/work/items/task.5329
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: vi.fn(),
  domains: vi.fn(),
  atoms: vi.fn(),
  list: vi.fn(),
  diff: vi.fn(),
  log: {
    child: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: state.user }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    nodeId: "node-a",
    log: state.log,
    clock: { now: () => new Date("2026-10-23T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    knowledgeAnalyticsSources: {
      domains: state.domains,
      atoms: state.atoms,
      contributions: state.list,
      changeIds: state.diff,
    },
  }),
}));

import * as handler from "@/app/api/v1/knowledge/analytics/route";

describe("authenticated knowledge analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.log.child.mockReturnValue(state.log);
    state.user.mockResolvedValue(TEST_SESSION_USER_1);
    state.domains.mockResolvedValue(["meta"]);
    state.atoms.mockResolvedValue([
      {
        id: "a",
        title: "A",
        domain: "meta",
        entryType: "rule",
        confidencePct: 30,
      },
    ]);
    state.list.mockResolvedValue([]);
  });
  it("returns local evidence while unsupported lookups stay unavailable", async () => {
    await testApiHandler({
      appHandler: handler,
      url: "/api/v1/knowledge/analytics?hours=168",
      async test({ fetch }) {
        const response = await fetch({
          headers: { authorization: "Bearer cogni_ag_sk_v1_fixture.signature" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.json();
        expect(body.summary.currentAtoms).toBe(1);
        expect(body.summary.lookupEvents).toBeNull();
        expect(body.coverage.lookups.reason).toBe("source_not_bound");
        expect(body.missionImpact).toBeNull();
        expect(body.rows[0].content).toBeUndefined();
      },
    });
  });
  it("rejects unauthenticated access before any source reads", async () => {
    state.user.mockResolvedValue(null);
    await testApiHandler({
      appHandler: handler,
      url: "/api/v1/knowledge/analytics",
      async test({ fetch }) {
        expect((await fetch()).status).toBe(401);
        expect(state.domains).not.toHaveBeenCalled();
      },
    });
  });
  it("rejects invalid or future windows before source reads", async () => {
    for (const query of [
      "hours=721",
      "hours=bad",
      "end=2999-01-01T00%3A00%3A00Z",
    ]) {
      await testApiHandler({
        appHandler: handler,
        url: `/api/v1/knowledge/analytics?${query}`,
        async test({ fetch }) {
          expect((await fetch()).status).toBe(400);
          expect(state.domains).not.toHaveBeenCalled();
        },
      });
    }
  });
});

it("admits one collection without a queue and authenticates every request", async () => {
  state.log.child.mockReturnValue(state.log);
  state.user.mockResolvedValue(TEST_SESSION_USER_1);
  state.atoms.mockResolvedValue([]);
  state.list.mockResolvedValue([]);
  let release!: (value: string[]) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  state.domains.mockImplementationOnce(() => {
    entered();
    return new Promise<string[]>((resolve) => {
      release = resolve;
    });
  });
  await testApiHandler({
    appHandler: handler,
    url: "/api/v1/knowledge/analytics",
    async test({ fetch }) {
      const first = fetch();
      await started;
      try {
        const busy = await fetch();
        expect(busy.status).toBe(429);
        expect(busy.headers.get("retry-after")).toBe("5");
        state.user.mockResolvedValue(null);
        expect((await fetch()).status).toBe(401);
      } finally {
        release([]);
      }
      expect((await first).status).toBe(200);
    },
  });
});
