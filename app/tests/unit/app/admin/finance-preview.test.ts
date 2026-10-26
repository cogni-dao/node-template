// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `tests/unit/app/admin/finance-preview`
 * Purpose: Prove preview-only query isolation and production route denial.
 * Scope: Real QueryObserver/client and server page guard; no network or database.
 * Invariants: Stale/invalidation never reads live money; no fixture cache reuse.
 * Side-effects: local test query cache
 * Links: app/dev/finance-preview/FixtureBoundary.tsx
 * @internal
 */
import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/shared/env", () => ({ getEnv: mocks.env }));
vi.mock("@/app/(admin)/AdminShell", () => ({ AdminShell: vi.fn() }));
vi.mock("@/app/(admin)/admin/payments/MoneyPlaneTable", () => ({
  MoneyPlaneTable: vi.fn(),
}));
vi.mock("@/components", () => ({
  AdminText: vi.fn(),
  Button: vi.fn(),
  PageContainer: vi.fn(),
}));

import { createFinancePreviewQueryClient } from "@/app/dev/finance-preview/FixtureBoundary";
import FinancePreviewPage from "@/app/dev/finance-preview/page";

describe("fixture shell treasury isolation", () => {
  it("never fetches an unseeded or stale fixture treasury, even after invalidation", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("LIVE_READ");
    });
    const fixture = {
      treasuryAddress: "0x1111111111111111111111111111111111111111",
      chainId: 8453,
      blockNumber: "0",
      balances: [
        {
          token: "USDC",
          tokenAddress: null,
          balanceWei: "7071234",
          balanceFormatted: "7.071234",
          decimals: 6,
        },
      ],
      timestamp: 0,
    };
    for (const snapshot of [undefined, fixture]) {
      const client = createFinancePreviewQueryClient(snapshot);
      const observer = new QueryObserver(client, {
        queryKey: ["treasury", "snapshot"],
        queryFn: fetch,
        staleTime: 0,
        retry: 1,
        refetchInterval: false,
        refetchOnWindowFocus: false,
      });
      const unsubscribe = observer.subscribe(() => {});
      await client.invalidateQueries({ queryKey: ["treasury", "snapshot"] });
      await client.refetchQueries({ queryKey: ["treasury", "snapshot"] });
      expect(fetch).not.toHaveBeenCalled();
      expect(observer.getCurrentResult().data).toEqual(snapshot);
      expect(observer.getCurrentResult().isLoading).toBe(false);
      unsubscribe();
      client.clear();
    }
    expect(
      createFinancePreviewQueryClient().getQueryData(["treasury", "snapshot"])
    ).toBeUndefined();
  });
  it.each([
    "production",
    "test",
  ])("returns404 in %s before evaluating fixture selection", async (env) => {
    mocks.env.mockReturnValue(env);
    const then = vi.fn();
    await expect(
      FinancePreviewPage({
        searchParams: { then } as unknown as Promise<{ scenario?: string }>,
      })
    ).rejects.toThrow("NOT_FOUND");
    expect(then).not.toHaveBeenCalled();
  });
});
