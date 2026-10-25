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

import type { MoneyPlaneRow } from "@cogni/money-plane";
import {
  createTable,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
} from "@tanstack/react-table";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  grid: vi.fn(),
  summary: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: vi.fn(),
}));
vi.mock("@/components", () => ({
  Button: vi.fn(),
  DataGrid: mocks.grid,
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
  summarizeCostRates: mocks.summary,
}));

import {
  MoneyPlaneTable,
  moneyPlaneColumns,
} from "@/app/(admin)/admin/payments/MoneyPlaneTable";

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
    await expect(getMoneyPlaneSnapshot()).resolves.toEqual({
      ...report,
      treasuryPlane: null,
      costRateEvidence: [],
    });
    expect(mocks.approver).toHaveBeenCalledWith("approved-wallet");
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.env).toHaveBeenCalledTimes(1);
    expect(mocks.creditReader).not.toHaveBeenCalled();
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
    const result = await getMoneyPlaneSnapshot();
    expect(result.treasuryPlane).toBe("base:operator-wallet");
    expect(mocks.creditReader).not.toHaveBeenCalled();
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
    for (const id of ["balance", "rate", "runway"]) {
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
  it("keeps unrounded values, distinct timestamps and raw reasons inside closed Details", () => {
    const data: MoneyPlaneRow[] = [
      {
        plane: "test-wallet",
        label: "Wallet",
        kind: "wallet",
        balance: 7.071234,
        currency: "USDC",
        burnPerDay: 0.00123456,
        runwayDays: null,
        grade: "UNKNOWN",
        observedAt: "2026-10-25T02:10:00Z",
        sourceObservedAt: "2026-10-25T01:30:00Z",
        freshness: "stale",
        reasonCode: "unreadable",
        detail: "Provider unavailable",
      },
    ];
    const table = createTable({
      data,
      columns: moneyPlaneColumns,
      state: { sorting: [] },
      onStateChange: () => {},
      renderFallbackValue: null,
      getCoreRowModel: getCoreRowModel(),
    });
    const cell = table
      .getRowModel()
      .rows[0]?.getAllCells()
      .find((cell) => cell.column.id === "details");
    if (!cell) throw new Error("Missing actual Details cell");
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        flexRender(cell.column.columnDef.cell, cell.getContext())
      )
    );
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
    for (const evidence of [
      "7.071234 USDC",
      "0.00123456 USDC/day",
      "2026-10-25T02:10:00Z",
      "2026-10-25T01:30:00Z",
      "unreadable",
      "Provider unavailable",
    ])
      expect(html).toContain(evidence);
  });
  it("renders DAO-only treasury and secondary custody while sending only costs to the actual grid", () => {
    const rows: MoneyPlaneRow[] = [
      {
        plane: "dao",
        label: "DAO treasury / Steward wallet",
        kind: "wallet",
        balance: 10,
        currency: "USDC",
        burnPerDay: null,
        runwayDays: null,
        grade: "INFO",
        observedAt: report.takenAt,
      },
      {
        plane: "operator",
        label: "Operator funds",
        kind: "wallet",
        balance: 20,
        currency: "USDC",
        burnPerDay: null,
        runwayDays: null,
        grade: "INFO",
        observedAt: report.takenAt,
      },
      {
        plane: "human",
        label: "Human custody",
        kind: "wallet",
        balance: 30,
        currency: "USDC",
        burnPerDay: null,
        runwayDays: null,
        grade: "INFO",
        observedAt: report.takenAt,
      },
      {
        plane: "cost",
        label: "Node hosting share",
        kind: "usage",
        balance: null,
        currency: null,
        burnPerDay: null,
        runwayDays: null,
        grade: "UNKNOWN",
        observedAt: report.takenAt,
      },
    ];
    mocks.summary.mockReturnValue({ cohorts: [], unattributedCount: 0 });
    const html = renderToStaticMarkup(
      createElement(MoneyPlaneTable, {
        rows,
        takenAt: report.takenAt,
        treasuryPlane: "dao",
        costRateEvidence: [],
      })
    );
    expect(html).toContain("Financials");
    expect(html).toContain("<strong>10 USDC</strong>");
    expect(html).toContain("<summary>Funding accounts</summary>");
    expect(html).toContain("20 USDC");
    expect(html).toContain("30 USDC");
    expect(html).not.toContain("60 USDC");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("Paid (cumulative)");
    expect(
      mocks.grid.mock.calls[0]?.[0].table.options.data.map(
        (row: MoneyPlaneRow) => row.plane
      )
    ).toEqual(["cost"]);
    expect(mocks.summary).toHaveBeenCalledWith([]);
  });
});
