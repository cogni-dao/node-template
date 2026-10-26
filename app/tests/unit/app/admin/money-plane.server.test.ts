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
vi.mock("@/components", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children?: import("react").ReactNode }) =>
    createElement("div", null, children);
  return {
    AdminText: ({
      as = "p",
      children,
    }: {
      as?: string;
      children?: import("react").ReactNode;
    }) => createElement(as, null, children),
    Card: box,
    CardContent: box,
    CardHeader: box,
    Dialog: box,
    DialogContent: vi.fn(),
    DialogHeader: box,
    DialogTitle: box,
    DialogDescription: box,
    DialogTrigger: box,
    Select: vi.fn(),
    SelectContent: vi.fn(),
    SelectItem: vi.fn(),
    SelectTrigger: vi.fn(),
    SelectValue: vi.fn(),
    Button: vi.fn(),
    DataGrid: mocks.grid,
    DataGridColumnHeader: vi.fn(),
    DataGridContainer: vi.fn(),
    DataGridTable: vi.fn(),
    StatusBadge: vi.fn(),
  };
});
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
  createMoneyPlaneColumns,
  MoneyPlaneEvidence,
  MoneyPlaneTable,
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
      configuredWalletPlanes: [],
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
    expect(result.configuredWalletPlanes).toEqual(["base:operator-wallet"]);
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
  it("keeps a configured invalid treasury identifiable without a successful read", async () => {
    mocks.walletConfig
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce("invalid");
    const result = await getMoneyPlaneSnapshot();
    expect(result.treasuryPlane).toBe("base:dao-treasury");
    expect(result.configuredWalletPlanes).toEqual(["base:dao-treasury"]);
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
          columns: createMoneyPlaneColumns(
            data.map((row) => ({
              sourceId: row.plane,
              ownerId: "dao",
              scopeId: "node",
              instrumentId: "provider-credit",
              basis: { kind: "contract", active: true },
              rate: {
                amount: String(row.balance),
                currency: "USD",
                per: "day",
              },
              sourceObservedAt: null,
              partial: false,
            }))
          ),
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
  it("groups explicit instruments before numeric rate and balance sorts, with source fallback and missing last", () => {
    const data: MoneyPlaneRow[] = [
      ["a-high", 100],
      ["b-low", 2],
      ["a-low", 3],
      ["missing", null],
    ].map(([plane, value]) => ({
      plane: String(plane),
      label: String(plane),
      kind: "usage",
      balance: value as number | null,
      currency: "USD",
      burnPerDay: value as number | null,
      runwayDays: null,
      grade: "UNKNOWN",
      observedAt: report.takenAt,
    }));
    const evidence = data
      .filter((r) => r.balance !== null)
      .map((r) => ({
        sourceId: r.plane,
        ownerId: "dao",
        scopeId: "node",
        instrumentId: r.plane.startsWith("a") ? "a-credit" : "b-credit",
        basis: { kind: "contract" as const, active: true },
        rate: {
          amount: String(r.balance),
          currency: "USD",
          per: "day" as const,
        },
        sourceObservedAt: null,
        partial: false,
      }));
    for (const id of ["balance", "rate"])
      for (const desc of [false, true]) {
        const table = createTable({
          data,
          columns: createMoneyPlaneColumns(evidence),
          state: { sorting: [{ id, desc }] },
          onStateChange: () => {},
          renderFallbackValue: null,
          getCoreRowModel: getCoreRowModel(),
          getSortedRowModel: getSortedRowModel(),
        });
        expect(table.getRowModel().rows.map((r) => r.original.plane)).toEqual(
          desc
            ? ["b-low", "a-high", "a-low", "missing"]
            : ["a-low", "a-high", "b-low", "missing"]
        );
      }
    const fallback = createTable({
      data,
      columns: createMoneyPlaneColumns(),
      state: { sorting: [{ id: "balance", desc: false }] },
      onStateChange: () => {},
      renderFallbackValue: null,
      getCoreRowModel: getCoreRowModel(),
      getSortedRowModel: getSortedRowModel(),
    });
    expect(fallback.getRowModel().rows.map((r) => r.original.plane)).toEqual([
      "a-high",
      "a-low",
      "b-low",
      "missing",
    ]);
  });

  it("keeps exact relevant source evidence without schema codes or null field dumps", () => {
    const row: MoneyPlaneRow = {
      plane: "private-source-id",
      label: "DAO treasury / Steward wallet",
      kind: "wallet",
      balance: 7.071234,
      currency: "USDC",
      burnPerDay: null,
      runwayDays: null,
      grade: "INFO",
      observedAt: "2026-10-25T02:10:00Z",
      sourceObservedAt: "2026-10-25T01:30:00Z",
      freshness: "stale",
      reasonCode: "unreadable",
      detail: "Raw provider implementation detail",
    };
    const html = renderToStaticMarkup(
      createElement(MoneyPlaneEvidence, { row })
    );
    expect(html).toContain("7.071234 USDC");
    expect(html).toContain("DAO treasury / Steward wallet");
    expect(html).toContain("Balance observed");
    expect(html).toContain("UTC");
    for (const hidden of [
      "private-source-id",
      "reasonCode",
      "unreadable",
      "Raw provider",
      "2026-10-25T01:30:00Z",
      "Burn/day",
      "<details",
    ])
      expect(html).not.toContain(hidden);
  });
  it("renders DAO-only treasury and secondary custody while sending only costs to the actual grid", () => {
    const rows: MoneyPlaneRow[] = [
      {
        plane: "dao",
        label: "Operator wallet / Steward wallet / DAO treasury",
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
        configuredWalletPlanes: ["dao", "operator", "human"],
      })
    );
    expect(html).toContain("Financials");
    expect(html).toContain("10 USDC");
    expect(html).toContain("Operator wallet / Steward wallet / DAO treasury");
    expect(html).toContain("Payment history is not available in this report.");
    expect(html).toContain("Other accounts");
    expect(html).not.toContain("<details");
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
