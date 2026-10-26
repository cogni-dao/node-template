// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
// @vitest-environment jsdom

/**
 * Module: `@tests/unit/app/admin/money-plane.server`
 * Purpose: Prove finance authorization runs before credentials or reader construction, the node composition
 *   (income → wallets → OpenRouter → operator-funded lines, each with its rail and payAction), the USD projection and
 *   summary, and that the page binds the package FinanceReport (ONE_UI) with this node's kit and the fund-steward POST.
 * Scope: Real report helper, real package summary/projection, mocked session/config/provider/ledger seams; no network or database.
 * Invariants: Non-approvers never reach financial data, independently of layout rendering.
 * Side-effects: none
 * Links: src/app/(admin)/admin/payments/{money-plane.server,FinanceReportClient.client,page}.tsx
 * @internal
 */

import type { MoneyPlaneRow, PlaneReader } from "@cogni/money-plane";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
	fx: vi.fn(),
	query: vi.fn(),
	redirect: vi.fn(),
	refresh: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	redirect: mocks.redirect,
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/components", async () => {
	const dialog = await import("@cogni/node-ui-kit/shadcn/dialog");
	const { createElement } = await import("react");
	type Props = { children?: ReactNode; asChild?: boolean } & Record<string, unknown>;
	return {
		...dialog,
		Button: ({ children, asChild, variant: _v, size: _s, ...props }: Props) =>
			asChild ? children : createElement("button", { type: "button", ...props }, children),
		Input: (props: Record<string, unknown>) => createElement("input", props),
		PageContainer: ({ children }: Props) => createElement("div", null, children),
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
vi.mock("@/bootstrap/capabilities/finance", () => ({ creditPurchasesQuery: mocks.query }));
vi.mock("@cogni/money-plane", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cogni/money-plane")>()),
	BASE_PUBLIC_RPC_URL: "https://rpc.example",
	baseWalletReader: mocks.walletReader,
	openRouterReader: mocks.creditReader,
	takeSnapshot: mocks.snapshot,
	fetchEcbRate: mocks.fx,
}));

import {
	FinanceReportClient,
	fundSteward,
	STEWARD_WITHDRAWAL_PATH,
} from "@/app/(admin)/admin/payments/FinanceReportClient.client";
import {
	getMoneyPlaneSnapshot,
	type NodeFinanceSnapshot,
	OPENROUTER_CHECKOUT_URL,
} from "@/app/(admin)/admin/payments/money-plane.server";
import FinancialsPage from "@/app/(admin)/admin/payments/page";
import { liveShapedPreview } from "@/app/dev/finance-preview/fixture";

const takenAt = "2026-10-25T00:00:00.000Z";
const report = { takenAt, rows: [] as MoneyPlaneRow[], worst: "UNKNOWN" as const };
const address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const other = (n: string) => address.replace("abcd", n);
const FUND_STEWARD = { kind: "fund-steward" as const };
const OPENROUTER_CHECKOUT = {
	kind: "steward-checkout" as const,
	vendor: "openrouter" as const,
	checkoutUrl: OPENROUTER_CHECKOUT_URL,
};

function stubReader(plane: string, row: Partial<MoneyPlaneRow> = {}): PlaneReader {
	return {
		plane,
		label: plane,
		kind: "wallet",
		async read() {
			return {
				plane,
				label: plane,
				kind: "wallet",
				balance: null,
				currency: null,
				burnPerDay: null,
				runwayDays: null,
				grade: "UNKNOWN",
				observedAt: takenAt,
				...row,
			};
		},
	};
}

function admit() {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue({ id: "admin", walletAddress: "approved-wallet" });
	mocks.approver.mockReturnValue(true);
	mocks.env.mockReturnValue({ OPENROUTER_API_KEY: "sk-or-test" });
	mocks.treasury.mockReturnValue(null);
	mocks.operator.mockReturnValue(null);
	mocks.steward.mockReturnValue(null);
	mocks.walletReader.mockImplementation(({ name, payAction }: { name: string; payAction?: unknown }) =>
		stubReader(`base:${name}`, payAction ? { payAction: payAction as MoneyPlaneRow["payAction"] } : {}),
	);
	mocks.creditReader.mockReturnValue(stubReader("openrouter:account"));
	mocks.snapshot.mockResolvedValue(report);
	mocks.fx.mockResolvedValue(null);
	mocks.query.mockReturnValue(async () => []);
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
			mocks.query,
			mocks.fx,
		]) {
			expect(read).not.toHaveBeenCalled();
		}
		expect(mocks.error).not.toHaveBeenCalled();
	});

	it("reads the report after the same repo-spec approver predicate allows the session", async () => {
		await expect(getMoneyPlaneSnapshot()).resolves.toEqual({
			...report,
			treasuryPlane: null,
			summary: {
				treasuryUsd: null,
				incomePerDay: null,
				burnPerDay: null,
				shortestRunway: null,
				ratesUsed: [],
				unconverted: [],
			},
		});
		expect(mocks.approver).toHaveBeenCalledWith("approved-wallet");
		expect(mocks.redirect).not.toHaveBeenCalled();
		expect(mocks.env).toHaveBeenCalledTimes(1);
		expect(mocks.walletReader).toHaveBeenCalledTimes(3);
		expect(mocks.creditReader).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: "sk-or-test", label: "OpenRouter credit", payAction: OPENROUTER_CHECKOUT }),
		);
		expect(mocks.snapshot).toHaveBeenCalledTimes(1);
		expect(mocks.fx).not.toHaveBeenCalled();
		expect(mocks.info).toHaveBeenCalledWith(
			expect.objectContaining({ event: "money_plane.snapshot", outcome: "success" }),
			"money_plane.snapshot",
		);
	});
});

describe("node composition", () => {
	beforeEach(admit);

	async function rowsOf(): Promise<MoneyPlaneRow[]> {
		const readers = mocks.snapshot.mock.calls[0]?.[0] as PlaneReader[];
		return Promise.all(readers.map((reader) => reader.read(new AbortController().signal)));
	}

	it("runs income, treasury, operator, steward, OpenRouter, Hosting and AI in that order with short labels", async () => {
		mocks.treasury.mockReturnValue(address);
		mocks.operator.mockReturnValue({ address: other("1234") });
		mocks.steward.mockReturnValue({ address: other("5678") });
		const result = await getMoneyPlaneSnapshot();
		expect(result.treasuryPlane).toBe("base:dao-treasury");
		const readers = mocks.snapshot.mock.calls[0]?.[0] as PlaneReader[];
		expect(readers.map((reader) => reader.plane)).toEqual([
			"income:credit-purchases",
			"income:node-services",
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

	it("attaches a rail to every row and the money chain to the operator wallet", async () => {
		mocks.treasury.mockReturnValue(address);
		mocks.operator.mockReturnValue({ address: other("1234") });
		mocks.steward.mockReturnValue({ address: other("5678") });
		await getMoneyPlaneSnapshot();
		const by = Object.fromEntries((await rowsOf()).map((row) => [row.plane, row]));
		expect(by["income:credit-purchases"]).toMatchObject({
			kind: "income",
			burnPerDay: 0,
			grade: "INFO",
			rail: { kind: "split-inflow", status: "supported" },
		});
		expect(by["income:node-services"]).toMatchObject({
			kind: "income",
			grade: "UNKNOWN",
			rail: { kind: "x402-auto", status: "planned", guide: "node-service-usdc-northstar" },
		});
		expect(by["base:dao-treasury"]?.rail).toEqual({ kind: "dao-vote", status: "planned", guide: "governance" });
		expect(by["base:operator-wallet"]).toMatchObject({
			payAction: FUND_STEWARD,
			rail: { kind: "steward-manual", status: "supported" },
			note: "User payments → operator wallet → steward wallet → OpenRouter",
		});
		expect(by["base:steward-wallet"]?.rail).toEqual({ kind: "none", status: "unsupported" });
		expect(by["openrouter:account"]?.rail).toEqual({ kind: "steward-manual", status: "supported" });
		for (const plane of ["hosting:operator-covered", "ai:operator-covered"])
			expect(by[plane]).toMatchObject({
				kind: "usage",
				balance: null,
				burnPerDay: null,
				payer: "Operator",
				beneficiary: "This node",
				coverage: "operator-covered",
				source: "Operator sponsorship",
				rail: { kind: "none", status: "planned", guide: "Operator-funded" },
			});
		expect(by["hosting:operator-covered"]?.detail).toBe("Funded by operator · cost not yet shared");
	});

	it("puts fund-steward on the operator wallet only when a steward wallet exists, else marks the rail unsupported", async () => {
		mocks.operator.mockReturnValue({ address: other("1234") });
		mocks.steward.mockReturnValue({ address: other("5678") });
		await getMoneyPlaneSnapshot();
		const byName = Object.fromEntries(mocks.walletReader.mock.calls.map((call) => [call[0].name, call[0]]));
		expect(byName["operator-wallet"].payAction).toEqual(FUND_STEWARD);
		expect(byName["steward-wallet"]).not.toHaveProperty("payAction");
		expect(byName["dao-treasury"]).not.toHaveProperty("payAction");

		admit();
		mocks.operator.mockReturnValue({ address: other("1234") });
		await getMoneyPlaneSnapshot();
		const operatorOnly = mocks.walletReader.mock.calls.find((call) => call[0].name === "operator-wallet")?.[0];
		expect(operatorOnly).not.toHaveProperty("payAction");
		const operatorRow = (await rowsOf()).find((row) => row.plane === "base:operator-wallet");
		expect(operatorRow?.rail).toEqual({ kind: "steward-manual", status: "unsupported" });
	});

	it("constructs one reader for aliased Base accounts, keeping the treasury id, the action and its rail", async () => {
		mocks.treasury.mockReturnValue(address);
		mocks.operator.mockReturnValue({ address: address.toUpperCase().replace("0X", "0x") });
		mocks.steward.mockReturnValue({ address });
		const result = await getMoneyPlaneSnapshot();
		expect(result.treasuryPlane).toBe("base:dao-treasury");
		expect(mocks.walletReader).toHaveBeenCalledTimes(1);
		expect(mocks.walletReader).toHaveBeenCalledWith(
			expect.objectContaining({ label: "DAO treasury / Operator wallet / Steward wallet", payAction: FUND_STEWARD }),
		);
		const merged = (await rowsOf()).find((row) => row.plane === "base:dao-treasury");
		expect(merged).toMatchObject({
			rail: { kind: "steward-manual", status: "supported" },
			note: "User payments → operator wallet → steward wallet → OpenRouter",
		});
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
			expect.objectContaining({ apiKey: undefined, payAction: OPENROUTER_CHECKOUT }),
		);
	});

	it("reads income from the ledger seam, and reports it UNKNOWN when no ledger is reachable", async () => {
		mocks.query.mockReturnValue(async () => [{ amountUsdCents: 4500, createdAt: new Date() }]);
		await getMoneyPlaneSnapshot();
		const income = (await rowsOf()).find((row) => row.plane === "income:credit-purchases");
		expect(income?.burnPerDay).toBeCloseTo(1.5, 9);
		admit();
		mocks.query.mockReturnValue(null);
		await getMoneyPlaneSnapshot();
		expect((await rowsOf()).find((row) => row.plane === "income:credit-purchases")).toMatchObject({
			grade: "UNKNOWN",
			reasonCode: "unreadable",
			detail: "ledger unavailable",
			rail: { kind: "split-inflow" },
		});
	});

	it("projects rows to USD, fetching the ECB rate only when a non-dollar row exists, and summarizes once", async () => {
		mocks.snapshot.mockResolvedValue({
			...report,
			rows: [
				{
					plane: "base:dao-treasury",
					label: "DAO treasury",
					kind: "wallet",
					balance: 74.52,
					currency: "USDC",
					burnPerDay: null,
					runwayDays: null,
					grade: "INFO",
					observedAt: takenAt,
				},
				{
					plane: "vendor:eur",
					label: "EUR credit",
					kind: "prepaid",
					balance: 10,
					currency: "EUR",
					burnPerDay: 1,
					runwayDays: 10,
					grade: "YELLOW",
					observedAt: takenAt,
					sourceObservedAt: takenAt,
					freshness: "current",
				},
			],
		});
		mocks.treasury.mockReturnValue(address);
		mocks.fx.mockResolvedValue({ pair: "EURUSD", value: 1.1188, source: "ECB", date: "2026-10-26" });
		const result = await getMoneyPlaneSnapshot();
		expect(mocks.fx).toHaveBeenCalledTimes(1);
		expect(mocks.fx.mock.calls[0]?.[1]).toBe("EURUSD");
		expect(result.rows[1]?.usd).toEqual({
			amount: 11.188,
			rate: { pair: "EURUSD", value: 1.1188, source: "ECB", date: "2026-10-26" },
		});
		expect(result.summary).toMatchObject({
			treasuryUsd: 74.52,
			burnPerDay: 1.1188,
			shortestRunway: { days: 10, label: "EUR credit" },
			ratesUsed: [{ pair: "EURUSD" }],
		});
	});
});

describe("the Financials page and its package binding", () => {
	beforeEach(admit);

	it("renders only the package report; no funding panel, no node-local table", async () => {
		const html = renderToStaticMarkup(await FinancialsPage());
		expect(html).toContain(">Financials</h1>");
		expect(html).not.toContain("Provider funding");
		expect(html).not.toContain("OpenRouter Funding");
		expect(mocks.snapshot).toHaveBeenCalledTimes(1);
	});

	it("binds this node's kit: groups, rails, Top up link and the inline fund-steward control", () => {
		render(createElement(FinanceReportClient, { report: liveShapedPreview as NodeFinanceSnapshot }));
		expect(screen.getByRole("heading", { level: 1, name: "Financials" })).toBeTruthy();
		expect(screen.getByText("Treasury $74.52 · Income $0.00/day")).toBeTruthy();
		const table = screen.getByRole("table");
		expect(Array.from(table.querySelectorAll("tr[data-finance-group]")).map((tr) => tr.getAttribute("data-finance-group"))).toEqual([
			"Income",
			"Costs",
			"Reserves",
		]);
		const operator = table.querySelector<HTMLElement>("tr[data-finance-row='base:operator-wallet']");
		expect(operator && within(operator).getByRole("button", { name: "Fund steward" })).toBeTruthy();
		const openrouter = table.querySelector<HTMLElement>("tr[data-finance-row='openrouter:account']");
		expect(openrouter && within(openrouter).getByRole("link", { name: /Top up/ }).getAttribute("href")).toBe(
			OPENROUTER_CHECKOUT_URL,
		);
		const hosting = table.querySelector<HTMLElement>("tr[data-finance-row='hosting:operator-covered']");
		expect(hosting && within(hosting).getByText("No rail")).toBeTruthy();
		expect(hosting && within(hosting).queryByRole("link")).toBeNull();
	});

	it("fundSteward POSTs the amount-only withdrawal and surfaces the server's text on failure", async () => {
		const ok = vi.fn(async () => ({ ok: true, json: async () => ({ txHash: "0xabc" }) }));
		await expect(fundSteward(2.5, ok as unknown as typeof fetch)).resolves.toEqual({ txHash: "0xabc" });
		expect(ok).toHaveBeenCalledWith(
			STEWARD_WITHDRAWAL_PATH,
			expect.objectContaining({ method: "POST", body: JSON.stringify({ amountUsd: 2.5 }) }),
		);
		const bad = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ detail: "amount too large" }) }));
		await expect(fundSteward(999, bad as unknown as typeof fetch)).rejects.toThrow("amount too large");
	});

	it("the inline control posts the typed amount and links the broadcast tx", async () => {
		const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ txHash: "0xabcdef1234567890" }) }));
		vi.stubGlobal("fetch", fetchSpy);
		render(createElement(FinanceReportClient, { report: liveShapedPreview as NodeFinanceSnapshot }));
		const operator = screen.getByRole("table").querySelector<HTMLElement>("tr[data-finance-row='base:operator-wallet']");
		if (!operator) throw new Error("missing operator row");
		const amount = within(operator).getByRole("spinbutton", { name: "Fund steward (USD)" });
		await userEvent.clear(amount);
		await userEvent.type(amount, "2.5");
		await userEvent.click(within(operator).getByRole("button", { name: "Fund steward" }));
		expect(fetchSpy).toHaveBeenCalledWith(
			STEWARD_WITHDRAWAL_PATH,
			expect.objectContaining({ method: "POST", body: JSON.stringify({ amountUsd: 2.5 }) }),
		);
		expect((await within(operator).findByRole("link", { name: /Sent 0xabcd…7890/ })).getAttribute("href")).toBe(
			"https://basescan.org/tx/0xabcdef1234567890",
		);
		vi.unstubAllGlobals();
	});
});
