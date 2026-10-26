// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
// @vitest-environment jsdom

/**
 * Module: `@tests/unit/app/admin/money-plane.server`
 * Purpose: Prove finance authorization runs before credentials or reader construction, the node composition
 *   (wallets → OpenRouter → operator-funded lines, with row payActions), and the Financials table shape:
 *   Line · Balance · Burn/day · Runway · Action, risk order, dashes with reasons, the fund-steward control
 *   POSTing the amount-only withdrawal, and no second rendering of any balance.
 * Scope: Real report helper and components, mocked session/config/provider seams; no network or database.
 * Invariants: Non-approvers never reach financial data, independently of layout rendering.
 * Side-effects: none
 * Links: src/app/(admin)/admin/payments/{money-plane.server,MoneyPlaneTable,RowAction.client,page}.tsx
 * @internal
 */

import type { MoneyPlaneRow, PlaneReader } from "@cogni/money-plane";
import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
} from "@tanstack/react-table";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  approver: vi.fn(),
  env: vi.fn(),
  treasury: vi.fn(),
  operator: vi.fn(),
  steward: vi.fn(),
  walletReader: vi.fn(),
  creditReader: vi.fn(),
  snapshot: vi.fn(),
  redirect: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  grid: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: vi.fn(),
}));
vi.mock("@/components", async () => {
  const { createElement } = await import("react");
  type Props = { children?: ReactNode; asChild?: boolean } & Record<
    string,
    unknown
  >;
  const tag =
    (name: string) =>
    ({ children, asChild: _asChild, ...props }: Props) =>
      createElement(name, props, children);
  const box = tag("div");
  return {
    AdminText: ({
      as = "p",
      children,
      className,
    }: {
      as?: string;
      children?: ReactNode;
      className?: string;
    }) => createElement(as, { className }, children),
    Button: ({ children, asChild, ...props }: Props) =>
      asChild ? children : createElement("button", props, children),
    Input: (props: Record<string, unknown>) => createElement("input", props),
    Dialog: box,
    DialogContent: vi.fn(),
    DialogHeader: box,
    DialogTitle: box,
    DialogDescription: box,
    DialogTrigger: ({ children }: Props) => children,
    DataGrid: mocks.grid,
    DataGridColumnHeader: vi.fn(),
    DataGridContainer: vi.fn(),
    DataGridTable: vi.fn(),
    PageContainer: box,
  };
});
vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: mocks.session }));
vi.mock("@/shared/config", () => ({
  isLedgerApprover: mocks.approver,
  getDaoTreasuryAddress: mocks.treasury,
  getOperatorWalletConfig: mocks.operator,
  getStewardWalletConfig: mocks.steward,
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

import {
  createMoneyPlaneColumns,
  MoneyPlaneEvidence,
  MoneyPlaneTable,
  refreshedText,
  reportedColumns,
  unavailableReason,
} from "@/app/(admin)/admin/payments/MoneyPlaneTable";
import {
  getMoneyPlaneSnapshot,
  OPENROUTER_CHECKOUT_URL,
} from "@/app/(admin)/admin/payments/money-plane.server";
import FinancialsPage from "@/app/(admin)/admin/payments/page";
import {
  fundSteward,
  RowAction,
  STEWARD_WITHDRAWAL_PATH,
} from "@/app/(admin)/admin/payments/RowAction.client";

const takenAt = "2026-10-25T00:00:00.000Z";
const report = { takenAt, rows: [], worst: "UNKNOWN" };
const address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const other = (n: string) => address.replace("abcd", n);
const FUND_STEWARD = { kind: "fund-steward" as const };
const OPENROUTER_CHECKOUT = {
  kind: "steward-checkout" as const,
  vendor: "openrouter" as const,
  checkoutUrl: OPENROUTER_CHECKOUT_URL,
};

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
  mocks.treasury.mockReturnValue(null);
  mocks.operator.mockReturnValue(null);
  mocks.steward.mockReturnValue(null);
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
      mocks.treasury,
      mocks.operator,
      mocks.steward,
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
        payAction: OPENROUTER_CHECKOUT,
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

  it("runs treasury, operator, steward, OpenRouter, Hosting and AI in that order with short labels", async () => {
    mocks.treasury.mockReturnValue(address);
    mocks.operator.mockReturnValue({ address: other("1234") });
    mocks.steward.mockReturnValue({ address: other("5678") });
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
      "Operator wallet",
      "Steward wallet",
    ]);
  });

  it("puts fund-steward on the operator wallet only when a steward wallet exists", async () => {
    mocks.operator.mockReturnValue({ address: other("1234") });
    mocks.steward.mockReturnValue({ address: other("5678") });
    await getMoneyPlaneSnapshot();
    const byName = Object.fromEntries(
      mocks.walletReader.mock.calls.map((call) => [call[0].name, call[0]])
    );
    expect(byName["operator-wallet"].payAction).toEqual(FUND_STEWARD);
    expect(byName["steward-wallet"]).not.toHaveProperty("payAction");
    expect(byName["dao-treasury"]).not.toHaveProperty("payAction");

    admit();
    mocks.operator.mockReturnValue({ address: other("1234") });
    await getMoneyPlaneSnapshot();
    const operatorOnly = mocks.walletReader.mock.calls.find(
      (call) => call[0].name === "operator-wallet"
    )?.[0];
    expect(operatorOnly).not.toHaveProperty("payAction");
  });

  it("constructs one reader for aliased Base accounts, keeping the treasury id and the action", async () => {
    mocks.treasury.mockReturnValue(address);
    mocks.operator.mockReturnValue({
      address: address.toUpperCase().replace("0X", "0x"),
    });
    mocks.steward.mockReturnValue({ address });
    const result = await getMoneyPlaneSnapshot();
    expect(result.treasuryPlane).toBe("base:dao-treasury");
    expect(mocks.walletReader).toHaveBeenCalledTimes(1);
    expect(mocks.walletReader).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "DAO treasury / Operator wallet / Steward wallet",
        payAction: FUND_STEWARD,
      })
    );
  });

  it("does not deduplicate unconfigured or invalid role addresses", async () => {
    mocks.treasury.mockReturnValue("invalid");
    mocks.operator.mockReturnValue({ address: "invalid" });
    const result = await getMoneyPlaneSnapshot();
    expect(result.treasuryPlane).toBe("base:dao-treasury");
    expect(mocks.walletReader).toHaveBeenCalledTimes(3);
  });

  it("still registers OpenRouter without a key so the row is explicit, not absent", async () => {
    mocks.env.mockReturnValue({});
    await getMoneyPlaneSnapshot();
    expect(mocks.creditReader).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: undefined, payAction: OPENROUTER_CHECKOUT })
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
    label: "Operator wallet",
    kind: "wallet",
    balance: 10.77,
    currency: "USDC",
    payAction: FUND_STEWARD,
  }),
  row("openrouter:account", "UNKNOWN", {
    label: "OpenRouter credit",
    balance: 3.1,
    currency: "USD",
    reasonCode: "burn_unmeasured",
    payAction: OPENROUTER_CHECKOUT,
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
const riskOrder = [
  "demo:red",
  "demo:yellow",
  "demo:green",
  "base:dao-treasury",
  "base:operator-wallet",
  "openrouter:account",
  "hosting:operator-covered",
];

describe("the Financials table", () => {
  beforeEach(admit);

  it("has exactly Line · Balance · Burn/day · Runway · Action and sorts RED, YELLOW, known numbers, placeholders last", () => {
    const columns = createMoneyPlaneColumns();
    expect(columns.map((c) => c.id)).toEqual([
      "line",
      "balance",
      "burn",
      "runway",
      "action",
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
    expect(table.getRowModel().rows.map((r) => r.original.plane)).toEqual(
      riskOrder
    );
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

  it("renders header, treasury line, short numbers, row actions, and nothing else", () => {
    const html = renderToStaticMarkup(
      createElement(MoneyPlaneTable, {
        rows,
        takenAt,
        treasuryPlane: "base:dao-treasury",
      })
    );
    expect(html).toContain("<h1");
    expect(html).toContain(">Financials</h1>");
    expect(html).toContain("Refreshed Oct 25, 12:00 AM");
    expect(html).toContain("Treasury 74.52 USDC");
    expect(html).toContain("10.77 USDC");
    expect(html).toContain("3.10 USD");
    expect(html).toContain("$0.50/day");
    expect(html).toContain(">4d<");
    expect(html).toContain("Operator-funded");
    expect(html).toContain("Fund steward");
    expect(html).toContain("Top up");
    expect(html).toContain(`href="${OPENROUTER_CHECKOUT_URL}"`);
    expect(html).toContain('aria-label="Operator wallet source"');
    for (const banned of [
      "Payment history",
      "not yet reported",
      "Provider funding",
      ">Source<",
      "Funded by operator",
      "Other accounts",
      "Not reported",
    ])
      expect(html).not.toContain(banned);
    // One rendering per balance: the stacked list and the (mocked) grid share rows; no card repeats them.
    expect(html.split("74.52 USDC").length - 1).toBe(2);
    const table = mocks.grid.mock.calls[0]?.[0].table;
    expect(
      table.getVisibleLeafColumns().map((c: { id: string }) => c.id)
    ).toEqual(["line", "balance", "burn", "runway", "action"]);
    expect(
      table.getRowModel().rows.map((r: { original: MoneyPlaneRow }) =>
        r.original.plane
      )
    ).toEqual(riskOrder);
  });

  it("omits all-dash Burn/day and Runway columns without adding a note", () => {
    const walletsOnly = rows.filter((r) => r.kind !== "prepaid");
    expect(reportedColumns(walletsOnly)).toEqual({ burn: false, runway: false });
    const html = renderToStaticMarkup(
      createElement(MoneyPlaneTable, {
        rows: walletsOnly,
        takenAt,
        treasuryPlane: "base:dao-treasury",
      })
    );
    expect(html).not.toContain(">Burn/day<");
    expect(html).not.toContain(">Runway<");
    expect(html).not.toContain("not yet reported");
    expect(html).toContain(">Balance<");
    const table = mocks.grid.mock.calls[0]?.[0].table;
    expect(table.getAllColumns()).toHaveLength(5);
    expect(
      table.getVisibleLeafColumns().map((c: { id: string }) => c.id)
    ).toEqual(["line", "balance", "action"]);
  });

  it("keeps a column for a known zero burn and only drops the all-null one", () => {
    const zeroBurn = [
      row("x", "GREEN", { balance: 5, currency: "USD", burnPerDay: 0 }),
      row("y", "UNKNOWN", { kind: "wallet", reasonCode: "unreadable" }),
    ];
    expect(reportedColumns(zeroBurn)).toEqual({ burn: true, runway: false });
    const html = renderToStaticMarkup(
      createElement(MoneyPlaneTable, { rows: zeroBurn, takenAt, treasuryPlane: null })
    );
    expect(html).toContain("$0.00/day");
    expect(html).not.toContain(">Runway<");
    const table = mocks.grid.mock.calls[0]?.[0].table;
    expect(
      table.getVisibleLeafColumns().map((c: { id: string }) => c.id)
    ).toEqual(["line", "balance", "burn", "action"]);
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

  it("shows the date only when the report is not from today", () => {
    const now = new Date("2026-10-26T20:00:00Z");
    expect(refreshedText("2026-10-26T19:42:00Z", "UTC", now)).toBe(
      "Refreshed 7:42 PM"
    );
    expect(refreshedText("2026-10-25T19:42:00Z", "UTC", now)).toBe(
      "Refreshed Oct 25, 7:42 PM"
    );
    expect(refreshedText("nope", "UTC", now)).toBe("Refreshed time unknown");
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

  it("keeps the dialog to six short rows: exact amount, time, reason, money chain", () => {
    const html = renderToStaticMarkup(
      createElement(MoneyPlaneEvidence, {
        row: row("private-source-id", "INFO", {
          label: "Operator wallet",
          kind: "wallet",
          balance: 10.771234,
          currency: "USDC",
          source: "Base JSON-RPC",
          sourceObservedAt: "2026-10-25T01:30:00Z",
          freshness: "current",
          detail: "0.0003 ETH",
          payAction: FUND_STEWARD,
        }),
      })
    );
    expect(html).toContain("Base JSON-RPC");
    expect(html).toContain("10.771234 USDC");
    expect(html).toContain("Oct 25, 2026, 1:30 AM UTC");
    expect(html).toContain("User payments → operator wallet → steward wallet");
    expect(html.split("<dt").length - 1).toBeLessThanOrEqual(6);
    for (const hidden of ["private-source-id", "reasonCode", "2026-10-25T01:30:00Z", "Unavailable"])
      expect(html).not.toContain(hidden);
    const steward = renderToStaticMarkup(
      createElement(MoneyPlaneEvidence, { row: rows[0] as MoneyPlaneRow })
    );
    expect(steward).not.toContain("Money chain");
  });
});

describe("row actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("fundSteward POSTs the amount-only withdrawal and reports tx or error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ txHash: "0xabc123def456" }) })
      .mockResolvedValueOnce({ ok: false, status: 402, json: async () => ({ detail: "insufficient funds" }) })
      .mockRejectedValueOnce(new Error("offline"));
    await expect(fundSteward(2, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      ok: true,
      txHash: "0xabc123def456",
    });
    expect(fetchImpl).toHaveBeenCalledWith(STEWARD_WITHDRAWAL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountUsd: 2 }),
    });
    await expect(fundSteward(2, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      ok: false,
      error: "insufficient funds",
    });
    await expect(fundSteward(2, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      ok: false,
      error: "offline",
    });
  });

  it("the inline control posts the typed amount and links the broadcast tx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ txHash: "0x1234567890abcdef" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RowAction, { action: FUND_STEWARD, label: "Operator wallet" }));
    const input = screen.getByLabelText(/Fund steward from Operator wallet/);
    expect(input).toHaveValue(1);
    fireEvent.change(input, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund steward" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Sent 0x1234…cdef/ })).toHaveAttribute(
        "href",
        "https://basescan.org/tx/0x1234567890abcdef"
      )
    );
    expect(fetchMock).toHaveBeenCalledWith(
      STEWARD_WITHDRAWAL_PATH,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ amountUsd: 2.5 }) })
    );
  });

  it("the inline control shows the server's error text and disables an invalid amount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "rpc down" }) })
    );
    render(createElement(RowAction, { action: FUND_STEWARD, label: "Operator wallet" }));
    fireEvent.click(screen.getByRole("button", { name: "Fund steward" }));
    await waitFor(() => expect(screen.getByText("rpc down")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/amount in USD/), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Fund steward" })).toBeDisabled();
  });

  it("renders a checkout link for steward-checkout and nothing without an action", () => {
    const html = renderToStaticMarkup(
      createElement(RowAction, { action: OPENROUTER_CHECKOUT, label: "OpenRouter credit" })
    );
    expect(html).toContain(`href="${OPENROUTER_CHECKOUT_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Top up");
    expect(
      renderToStaticMarkup(createElement(RowAction, { action: undefined, label: "x" }))
    ).toBe("");
  });
});

describe("the Financials page", () => {
  beforeEach(admit);

  it("renders only the table; the funding panel is gone", async () => {
    const html = renderToStaticMarkup(await FinancialsPage());
    expect(html).toContain(">Financials</h1>");
    expect(html).not.toContain("Provider funding");
    expect(html).not.toContain("OpenRouter Funding");
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  });
});
