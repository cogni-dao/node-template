// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/admin/money-plane.server`
 * Purpose: Prove finance data authorization runs before credentials or reader construction.
 * Scope: Real report helper, mocked session/config/provider seams; no network or database.
 * Invariants: Non-approvers never reach financial data, independently of layout rendering.
 * Side-effects: none
 * Links: src/app/(admin)/admin/payments/money-plane.server.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
} from "@tanstack/react-table";
import type { MoneyPlaneRow } from "@cogni/money-plane";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  approver: vi.fn(),
  env: vi.fn(),
  walletConfig: vi.fn(),
  walletReader: vi.fn(),
  creditReader: vi.fn(),
  snapshot: vi.fn(),
  redirect: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: vi.fn(),
}));
vi.mock("@/components", () => ({
  Button: vi.fn(),
  DataGrid: vi.fn(),
  DataGridColumnHeader: vi.fn(),
  DataGridContainer: vi.fn(),
  DataGridTable: vi.fn(),
  StatusBadge: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: mocks.session }));
vi.mock("@/shared/config", () => ({
  isLedgerApprover: mocks.approver,
  getDaoTreasuryAddress: mocks.walletConfig,
  getOperatorWalletConfig: mocks.walletConfig,
  getStewardWalletConfig: mocks.walletConfig,
}));
vi.mock("@/shared/env", () => ({ serverEnv: mocks.env }));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: { MONEY_PLANE_SNAPSHOT: "money_plane.snapshot" },
  makeLogger: () => ({ info: mocks.info, error: mocks.error }),
}));
vi.mock("@/shared/web3", () => ({ USDC_TOKEN_ADDRESS: "test-usdc" }));
vi.mock("@cogni/money-plane", () => ({
  BASE_PUBLIC_RPC_URL: "https://rpc.example",
  baseWalletReader: mocks.walletReader,
  openRouterReader: mocks.creditReader,
  takeSnapshot: mocks.snapshot,
  unknownRow: vi.fn(),
  summarizeRows: vi.fn(),
}));

import { moneyPlaneColumns } from "@/app/(admin)/admin/payments/MoneyPlaneTable";

import { getMoneyPlaneSnapshot } from "@/app/(admin)/admin/payments/money-plane.server";

const report = {
  takenAt: "2026-10-25T00:00:00.000Z",
  rows: [],
  worst: "UNKNOWN",
};

describe("finance authorization at the read boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.approver.mockImplementation((wallet) => wallet === "approved-wallet");
    mocks.redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
    mocks.env.mockReturnValue({});
    mocks.walletConfig.mockReturnValue(null);
    mocks.snapshot.mockResolvedValue(report);
  });

  it.each([
    ["anonymous", null],
    ["walletless OAuth", { id: "oauth-user", walletAddress: null }],
    ["non-approver", { id: "other-user", walletAddress: "other-wallet" }],
  ] as const)("denies %s before any financial reads", async (_label, user) => {
    mocks.session.mockResolvedValue(user);
    await expect(getMoneyPlaneSnapshot()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/dashboard");
    expect(mocks.approver).toHaveBeenCalledWith(user?.walletAddress ?? null);
    for (const read of [
      mocks.env,
      mocks.walletConfig,
      mocks.walletReader,
      mocks.creditReader,
      mocks.snapshot,
    ]) {
      expect(read).not.toHaveBeenCalled();
    }
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("reads the report after the same repo-spec approver predicate allows the session", async () => {
    mocks.session.mockResolvedValue({
      id: "admin",
      walletAddress: "approved-wallet",
    });
    await expect(getMoneyPlaneSnapshot()).resolves.toEqual(report);
    expect(mocks.approver).toHaveBeenCalledWith("approved-wallet");
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.env).toHaveBeenCalledTimes(1);
    expect(mocks.creditReader).toHaveBeenCalledTimes(1);
    expect(mocks.walletReader).toHaveBeenCalledTimes(3);
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  });
});

describe("account deduplication and the actual financial grid", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.session.mockResolvedValue({
      id: "admin",
      walletAddress: "approved-wallet",
    });
    mocks.approver.mockReturnValue(true);
    mocks.env.mockReturnValue({});
    mocks.snapshot.mockResolvedValue(report);
  });
  it("constructs one reader for aliased Base accounts before any read", async () => {
    const address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    mocks.walletConfig
      .mockReturnValueOnce({ address })
      .mockReturnValueOnce({
        address: address.toUpperCase().replace("0X", "0x"),
      })
      .mockReturnValueOnce(address);
    await getMoneyPlaneSnapshot();
    expect(mocks.walletReader).toHaveBeenCalledTimes(1);
    expect(mocks.walletReader).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Operator wallet / Steward wallet / DAO treasury",
      })
    );
  });
  it("does not deduplicate unconfigured or invalid role addresses", async () => {
    mocks.walletConfig
      .mockReturnValueOnce({ address: "invalid" })
      .mockReturnValueOnce({ address: "invalid" })
      .mockReturnValueOnce(null);
    await getMoneyPlaneSnapshot();
    expect(mocks.walletReader).toHaveBeenCalledTimes(3);
  });
  it("sorts actual grid columns numerically with missing last in both directions", () => {
    const data: MoneyPlaneRow[] = [2, null, 10].map((balance, index) => ({
      plane: String(index),
      label: String(index),
      kind: "prepaid",
      balance,
      currency: "USD",
      burnPerDay: balance,
      runwayDays: balance,
      grade: "UNKNOWN",
      observedAt: "2026-10-25T00:00:00Z",
      ...(balance === null
        ? {}
        : {
            cumulativeVendorTransfer: {
              amount: String(balance),
              currency: "USD",
            },
          }),
    }));
    for (const id of ["balance", "burn", "runway", "paid"]) {
      for (const desc of [false, true]) {
        const table = createTable({
          data,
          columns: moneyPlaneColumns,
          state: { sorting: [{ id, desc }] },
          onStateChange: () => {},
          renderFallbackValue: null,
          getCoreRowModel: getCoreRowModel(),
          getSortedRowModel: getSortedRowModel(),
        });
        expect(
          table.getRowModel().rows.map((row) => row.original.balance)
        ).toEqual(desc ? [10, 2, null] : [2, 10, null]);
      }
    }
  });
});
