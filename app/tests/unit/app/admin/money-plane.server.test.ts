// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/admin/money-plane.server`
 * Purpose: Prove finance authorization runs before credentials or reader construction, the node composition
 *   (wallets → OpenRouter → operator-funded lines), and the Financials table shape: five columns, risk order,
 *   dashes with reasons, and the restored Provider Funding rail on the page.
 * Scope: Real report helper and components, mocked session/config/provider seams; no network or database.
 * Invariants: Non-approvers never reach financial data, independently of layout rendering.
 * Side-effects: none
 * Links: src/app/(admin)/admin/payments/{money-plane.server,MoneyPlaneTable,page}.tsx
 * @internal
 */

import type { MoneyPlaneRow, PlaneReader } from "@cogni/money-plane";
import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
} from "@tanstack/react-table";
import { createElement, type ReactNode } from "react";
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
  funding: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: vi.fn(),
}));
vi.mock("@/components", async () => {
  const { createElement } = await import("react");
  type Props = { children?: ReactNode; asChild?: boolean; id?: string };
  const tag =
    (name: string) =>
    ({ children, ...props }: Props & Record<string, unknown>) =>
      createElement(name, { id: props.id }, children);
  const box = tag("div");
  return {
    AdminText: ({
      as = "p",
      children,
    }: {
      as?: string;
      children?: ReactNode;
    }) => createElement(as, null, children),
    Button: ({ children, asChild }: Props) =>
      asChild ? children : createElement("button", null, children),
    Card: box,
    CardContent: box,
    Dialog: box,
    DialogContent: vi.fn(),
    DialogHeader: box,
    DialogTitle: box,
    DialogDescription: box,
    DialogTrigger: box,
    DataGrid: mocks.grid,
    DataGridColumnHeader: vi.fn(),
    DataGridContainer: vi.fn(),
    DataGridTable: vi.fn(),
    HintText: tag("p"),
    Input: () => createElement("input"),
    PageContainer: box,
    Separator: () => createElement("hr"),
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
}));
vi.mock("@/app/(admin)/admin/payments/funding.server", () => ({
  getAiFunding: mocks.funding,
}));

import {
  createMoneyPlaneColumns,
  MoneyPlaneEvidence,
  MoneyPlaneTable,
  unavailableReason,
} from "@/app/(admin)/admin/payments/MoneyPlaneTable";
import { getMoneyPlaneSnapshot } from "@/app/(admin)/admin/payments/money-plane.server";
import FinancialsPage from "@/app/(admin)/admin/payments/page";

const takenAt = "2026-10-25T00:00:00.000Z";
const report = { takenAt, rows: [], worst: "UNKNOWN" };
const address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

function row(
  plane: string,
  grade: MoneyPlaneRow["grade"],
  extra: Partial<MoneyPlaneRow> = {}
): MoneyPlaneRow {
  return {
    plane,
    label: plane,
    kind: "prepaid",
    balance: null,
    currency: null,
    burnPerDay: null,
    runwayDays: null,
    grade,
    observedAt: takenAt,
    ...extra,
  };
}

function admit() {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({
    id: "admin",
    walletAddress: "approved-wallet",
  });
  mocks.approver.mockReturnValue(true);
  mocks.env.mockReturnValue({ OPENROUTER_API_KEY: "sk-or-test" });
  mocks.walletConfig.mockReturnValue(null);
  mocks.walletReader.mockImplementation(({ name }: { name: string }) => ({
    plane: `base:${name}`,
  }));
  mocks.creditReader.mockReturnValue({ plane: "openrouter:account" });
  mocks.snapshot.mockResolvedValue(report);
}

describe("finance authorization at the read boundary", () => {
  beforeEach(() => {
    admit();
    mocks.approver.mockImplementation((wallet) => wallet === "approved-wallet");
    mocks.redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
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
    await expect(getMoneyPlaneSnapshot()).resolves.toEqual({
      ...report,
      treasuryPlane: null,
    });
    expect(mocks.approver).toHaveBeenCalledWith("approved-wallet");
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.env).toHaveBeenCalledTimes(1);
    expect(mocks.walletReader).toHaveBeenCalledTimes(3);
    expect(mocks.creditReader).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-or-test",
        label: "OpenRouter credit",
      })
    );
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "money_plane.snapshot",
        outcome: "success",
      }),
      "money_plane.snapshot"
    );
  });
});

describe("node composition", () => {
  beforeEach(admit);

  it("runs treasury, operator, steward, OpenRouter, Hosting and AI in that order", async () => {
    mocks.walletConfig
      .mockReturnValueOnce(address)
      .mockReturnValueOnce({ address: address.replace("abcd", "1234") })
      .mockReturnValueOnce({ address: address.replace("abcd", "5678") });
    const result = await getMoneyPlaneSnapshot();
    expect(result.treasuryPlane).toBe("base:dao-treasury");
    const readers = mocks.snapshot.mock.calls[0]?.[0] as PlaneReader[];
    expect(readers.map((reader) => reader.plane)).toEqual([
      "base:dao-treasury",
      "base:operator-wallet",
      "base:steward-wallet",
      "openrouter:account",
      "hosting:operator-covered",
      "ai:operator-covered",
    ]);
    expect(mocks.walletReader.mock.calls.map((call) => call[0].label)).toEqual([
      "DAO treasury",
      "Operator wallet · working capital",
      "Steward wallet · human custody",
    ]);
  });

  it("constructs one reader for aliased Base accounts and keeps the treasury identifiable", async () => {
    mocks.walletConfig
      .mockReturnValueOnce(address)
      .mockReturnValueOnce({
        address: address.toUpperCase().replace("0X", "0x"),
      })
      .mockReturnValueOnce({ address });
    const result = await getMoneyPlaneSnapshot();
    expect(result.treasuryPlane).toBe("base:dao-treasury");
    expect(mocks.walletReader).toHaveBeenCalledTimes(1);
    expect(mocks.walletReader).toHaveBeenCalledWith(
      expect.objectContaining({
        label:
          "DAO treasury / Operator wallet · working capital / Steward wallet · human custody",
      })
    );
  });

  it("does not deduplicate unconfigured or invalid role addresses", async () => {
    mocks.walletConfig
      .mockReturnValueOnce("invalid")
      .mockReturnValueOnce({ address: "invalid" })
      .mockReturnValueOnce(null);
    const result = await getMoneyPlaneSnapshot();
    expect(result.treasuryPlane).toBe("base:dao-treasury");
    expect(mocks.walletReader).toHaveBeenCalledTimes(3);
  });

  it("still registers OpenRouter without a key so the row is explicit, not absent", async () => {
    mocks.env.mockReturnValue({});
    await getMoneyPlaneSnapshot();
    expect(mocks.creditReader).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: undefined })
    );
  });

  it("reports Hosting and AI as operator-funded lines with no numbers", async () => {
    await getMoneyPlaneSnapshot();
    const readers = mocks.snapshot.mock.calls[0]?.[0] as PlaneReader[];
    const [hosting, ai] = await Promise.all(
      readers.slice(4).map((reader) => reader.read(new AbortController().signal))
    );
    expect(hosting).toMatchObject({
      label: "Hosting",
      kind: "usage",
      balance: null,
      burnPerDay: null,
      payer: "Operator",
      beneficiary: "This node",
      coverage: "operator-covered",
      source: "Operator sponsorship",
      detail: "Funded by operator · cost not yet shared",
    });
    expect(ai).toMatchObject({
      label: "AI",
      coverage: "operator-covered",
      detail: "Funded by operator · usage not yet shared",
    });
  });
});

describe("the Financials table", () => {
  beforeEach(admit);

  const rows: MoneyPlaneRow[] = [
    row("base:dao-treasury", "INFO", {
      label: "DAO treasury",
      kind: "wallet",
      balance: 74.52,
      currency: "USDC",
      source: "Base JSON-RPC",
      sourceObservedAt: takenAt,
      freshness: "current",
    }),
    row("base:operator-wallet", "INFO", {
      label: "Operator wallet · working capital",
      kind: "wallet",
      balance: 10.77,
      currency: "USDC",
    }),
    row("openrouter:account", "UNKNOWN", {
      label: "OpenRouter credit",
      balance: 3.1,
      currency: "USD",
      reasonCode: "burn_unmeasured",
    }),
    row("hosting:operator-covered", "UNKNOWN", {
      label: "Hosting",
      kind: "usage",
      payer: "Operator",
      coverage: "operator-covered",
      reasonCode: "unconfigured",
    }),
    row("demo:red", "RED", {
      label: "Zebra credit",
      balance: 2,
      currency: "USD",
      burnPerDay: 0.5,
      runwayDays: 4,
    }),
    row("demo:green", "GREEN", {
      label: "Alpha credit",
      balance: 90,
      currency: "USD",
      burnPerDay: 1,
      runwayDays: 90,
    }),
    row("demo:yellow", "YELLOW", {
      label: "Mid credit",
      balance: 10,
      currency: "USD",
      burnPerDay: 1,
      runwayDays: 10,
    }),
  ];

  it("has exactly five columns and sorts RED, YELLOW, UNKNOWN, GREEN, INFO then label by default", () => {
    const columns = createMoneyPlaneColumns();
    expect(columns.map((c) => c.id)).toEqual([
      "line",
      "balance",
      "burn",
      "runway",
      "source",
    ]);
    const table = createTable({
      data: rows,
      columns,
      state: { sorting: [{ id: "line", desc: false }] },
      onStateChange: () => {},
      renderFallbackValue: null,
      getCoreRowModel: getCoreRowModel(),
      getSortedRowModel: getSortedRowModel(),
    });
    expect(table.getRowModel().rows.map((r) => r.original.plane)).toEqual([
      "demo:red",
      "demo:yellow",
      "hosting:operator-covered",
      "openrouter:account",
      "demo:green",
      "base:dao-treasury",
      "base:operator-wallet",
    ]);
  });

  it("sorts numeric columns with missing values last in both directions", () => {
    for (const id of ["balance", "burn", "runway"]) {
      for (const desc of [false, true]) {
        const table = createTable({
          data: rows,
          columns: createMoneyPlaneColumns(),
          state: { sorting: [{ id, desc }] },
          onStateChange: () => {},
          renderFallbackValue: null,
          getCoreRowModel: getCoreRowModel(),
          getSortedRowModel: getSortedRowModel(),
        });
        const values = table
          .getRowModel()
          .rows.map((r) => r.getValue<number | undefined>(id));
        const known = values.filter((v) => v !== undefined) as number[];
        expect(values.slice(known.length).every((v) => v === undefined)).toBe(
          true
        );
        expect(known).toEqual(
          [...known].sort((a, b) => (desc ? b - a : a - b))
        );
      }
    }
  });

  it("renders the header, treasury summary, dashes and the footer without pills or sections", () => {
    const html = renderToStaticMarkup(
      createElement(MoneyPlaneTable, {
        rows,
        takenAt,
        treasuryPlane: "base:dao-treasury",
      })
    );
    expect(html).toContain("<h1>Financials</h1>");
    expect(html).toContain("Report refreshed Oct 25, 2026, 12:00 AM UTC");
    expect(html).toContain("Treasury 74.52 USDC");
    expect(html).toContain("10.77 USDC");
    expect(html).toContain("3.10 USD");
    expect(html).toContain("$0.50 / day");
    expect(html).toContain("4 d");
    expect(html).toContain("Funded by operator");
    expect(html).toContain("Payment history is not included in this report.");
    expect(html).toContain("Refresh");
    for (const banned of [
      "Other accounts",
      "Services",
      "Operating costs",
      "Not reported",
      "Low",
      "Holding",
      "Treasury not identified",
    ])
      expect(html).not.toContain(`>${banned}<`);
    const table = mocks.grid.mock.calls[0]?.[0].table;
    expect(table.getAllColumns()).toHaveLength(5);
    expect(
      table.getRowModel().rows.map((r: { original: MoneyPlaneRow }) =>
        r.original.plane
      )
    ).toEqual([
      "demo:red",
      "demo:yellow",
      "hosting:operator-covered",
      "openrouter:account",
      "demo:green",
      "base:dao-treasury",
      "base:operator-wallet",
    ]);
  });

  it("explains an unavailable treasury balance in one line", () => {
    const html = renderToStaticMarkup(
      createElement(MoneyPlaneTable, {
        rows: [
          row("base:dao-treasury", "UNKNOWN", {
            label: "DAO treasury",
            kind: "wallet",
            reasonCode: "unreadable",
          }),
        ],
        takenAt,
        treasuryPlane: "base:dao-treasury",
      })
    );
    expect(html).toContain("Treasury balance unavailable · RPC unavailable");
    expect(html).toContain(">—<");
  });

  it("maps reason codes to one human line each", () => {
    expect(unavailableReason(rows[0] as MoneyPlaneRow)).toBeNull();
    expect(unavailableReason(rows[2] as MoneyPlaneRow)).toBe(
      "burn not measured"
    );
    expect(unavailableReason(rows[3] as MoneyPlaneRow)).toBe(
      "cost reported by operator, not yet shared"
    );
    expect(
      unavailableReason(
        row("openrouter:account", "UNKNOWN", { reasonCode: "unconfigured" })
      )
    ).toBe("no key configured");
    expect(
      unavailableReason(
        row("base:x", "UNKNOWN", { kind: "wallet", reasonCode: "unconfigured" })
      )
    ).toBe("no address configured");
  });

  it("keeps exact source evidence readable without schema codes", () => {
    const html = renderToStaticMarkup(
      createElement(MoneyPlaneEvidence, {
        row: row("private-source-id", "INFO", {
          label: "Steward wallet · human custody",
          kind: "wallet",
          balance: 7.071234,
          currency: "USDC",
          source: "Base JSON-RPC",
          sourceObservedAt: "2026-10-25T01:30:00Z",
          freshness: "current",
          detail: "0.0003 ETH",
        }),
      })
    );
    expect(html).toContain("Base JSON-RPC");
    expect(html).toContain("7.071234 USDC");
    expect(html).toContain("Oct 25, 2026, 1:30 AM UTC");
    for (const hidden of [
      "private-source-id",
      "reasonCode",
      "2026-10-25T01:30:00Z",
      "Unavailable",
    ])
      expect(html).not.toContain(hidden);
  });
});

describe("the Financials page", () => {
  beforeEach(admit);

  it("renders the table first, then the restored Provider Funding rail", async () => {
    mocks.funding.mockResolvedValue({
      openRouterRemainingUsd: 3.1,
      operatorWalletUsdc: 10.77,
      stewardWalletUsdc: 7.07,
      operatorWalletAddress: address,
      stewardWalletAddress: address,
    });
    const html = renderToStaticMarkup(await FinancialsPage());
    const financials = html.indexOf("<h1>Financials</h1>");
    const funding = html.indexOf("Provider funding");
    expect(financials).toBeGreaterThan(-1);
    expect(funding).toBeGreaterThan(financials);
    expect(html).toContain("<hr/>");
    expect(html).toContain("Fund steward");
    expect(html).toContain("Top up OpenRouter");
    expect(mocks.funding).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.funding.mock.invocationCallOrder[0] ?? 0
    );
  });
});
