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
		Card: ({ children, className }: Props) => createElement("div", { className }, children),
		CardContent: ({ children, className }: Props) => createElement("div", { className }, children),
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
	takeSnapshot: mocks.snapshot,
	fetchEcbRate: mocks.fx,
}));

import { StewardWithdrawalRejected, summarize } from "@cogni/money-plane";

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
const transactionHash = `0x${"a".repeat(60)}7890`;
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
	mocks.snapshot.mockResolvedValue(report);
	mocks.fx.mockResolvedValue(null);
	mocks.query.mockReturnValue(async () => ({ totalUsdCents: 0, count: 0 }));
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
			stewardWalletUrl: null,
			summary: {
				treasuryUsd: null,
				incomePerDay: null,
				burnPerDay: null,
				runwayDays: null,
				runwayReason: "treasury_unreadable",
				costCoverageGaps: [],
				nextDeadline: null,
				windowDays: 30,
				ratesUsed: [],
				unconverted: [],
			},
		});
		expect(mocks.approver).toHaveBeenCalledWith("approved-wallet");
		expect(mocks.redirect).not.toHaveBeenCalled();
		expect(mocks.env).toHaveBeenCalledTimes(1);
		expect(mocks.walletReader).toHaveBeenCalledTimes(3);
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
		expect(by["openrouter:account"]).toMatchObject({
			grade: "UNKNOWN",
			reasonCode: "unconfigured",
			detail: "needs a management key · task.5361",
			rail: { kind: "steward-manual", status: "supported" },
			payAction: OPENROUTER_CHECKOUT,
		});
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

	it("never calls OpenRouter /credits with the inference key; the row stays UNKNOWN with Top up reachable", async () => {
		mocks.env.mockReturnValue({ OPENROUTER_API_KEY: "sk-or-test" });
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await getMoneyPlaneSnapshot();
		const row = (await rowsOf()).find((r) => r.plane === "openrouter:account");
		expect(row).toMatchObject({ balance: null, grade: "UNKNOWN", detail: "needs a management key · task.5361" });
		expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("openrouter.ai"))).toBe(false);
		vi.unstubAllGlobals();
	});

	it("exposes the steward wallet explorer link for the result-unknown check", async () => {
		mocks.steward.mockReturnValue({ address: other("5678") });
		const result = await getMoneyPlaneSnapshot();
		expect(result.stewardWalletUrl).toBe(`https://basescan.org/address/${other("5678")}`);
	});

	it("reads income from the ledger seam, and reports it UNKNOWN when no ledger is reachable", async () => {
		mocks.query.mockReturnValue(async () => ({ totalUsdCents: 4500, count: 3 }));
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

	it("bounds the FX read within the remaining page budget so a hanging rate service never hangs the report", async () => {
		const controller = new AbortController();
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		mocks.snapshot.mockResolvedValue({
			...report,
			rows: [
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
				},
			],
		});
		// Behaves like the real fetchEcbRate over a fetch that only ends when its signal aborts.
		mocks.fx.mockImplementation(
			(_fetch: unknown, _pair: string, signal?: AbortSignal) =>
				new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null))),
		);
		const pending = getMoneyPlaneSnapshot();
		let settled = false;
		pending.then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(mocks.fx).toHaveBeenCalled());
		expect(settled).toBe(false);
		const budget = timeoutSpy.mock.calls[0]?.[0] as number;
		expect(budget).toBeGreaterThanOrEqual(1_000);
		expect(budget).toBeLessThanOrEqual(8_000);
		controller.abort();
		const result = await pending;
		expect(mocks.fx.mock.calls[0]?.[2]).toBe(controller.signal);
		expect(result.rows[0]?.usd).toBeUndefined();
		expect(result.summary.unconverted).toEqual(["EUR credit"]);
		timeoutSpy.mockRestore();
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
					sourceObservedAt: takenAt,
					freshness: "current",
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
			nextDeadline: { days: 10, label: "EUR credit" },
			ratesUsed: [{ pair: "EURUSD" }],
		});
		expect(result.summary.runwayDays).toBeCloseTo(74.52 / 1.1188, 9);
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
		expect(document.querySelector("[data-finance-stat='Treasury']")?.textContent).toBe("$74.52");
		expect(document.querySelector("[data-finance-stat='Cash received']")?.textContent).toBe("$0.00/day");
		expect(document.querySelector("[data-finance-stat='Burn']")?.textContent).toBe("—");
		expect(document.querySelector("[data-finance-stat='Runway']")?.textContent).toBe("—");
		expect(screen.getByText("credit purchases · 30d")).toBeTruthy();
		expect(screen.getByText("Costs incomplete")).toBeTruthy();
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
		expect(openrouter?.textContent).toContain("—");
		const hosting = table.querySelector<HTMLElement>("tr[data-finance-row='hosting:operator-covered']");
		expect(hosting && within(hosting).getByText("No rail")).toBeTruthy();
		expect(hosting && within(hosting).queryByRole("link")).toBeNull();
	});

	it("fundSteward POSTs the amount-only withdrawal and surfaces the server's text on failure", async () => {
		const ok = vi.fn(async () => ({ ok: true, json: async () => ({ txHash: transactionHash, confirmed: true }) }));
		await expect(fundSteward(2.5, ok as unknown as typeof fetch)).resolves.toEqual({ txHash: transactionHash, confirmed: true });
		expect(ok).toHaveBeenCalledWith(
			STEWARD_WITHDRAWAL_PATH,
			expect.objectContaining({ method: "POST", body: JSON.stringify({ amountUsd: 2.5 }) }),
		);
		expect((ok.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.any(AbortSignal) });
		const bad = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ detail: "amount too large" }) }));
		await expect(fundSteward(999, bad as unknown as typeof fetch)).rejects.toThrow(StewardWithdrawalRejected);
		const bareRefusal = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
		await expect(fundSteward(1, bareRefusal as unknown as typeof fetch)).rejects.toThrow("HTTP 403");
		await expect(fundSteward(1, bareRefusal as unknown as typeof fetch)).rejects.toThrow(StewardWithdrawalRejected);
		const lost = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new Error("lost");
			},
		}));
		await expect(fundSteward(1, lost as unknown as typeof fetch)).rejects.not.toBeInstanceOf(
			StewardWithdrawalRejected,
		);
		// A 5xx may arrive after the transfer was broadcast: unknown outcome, never a refusal.
		const serverError = vi.fn(async () => ({
			ok: false,
			status: 500,
			json: async () => ({ error: "Internal server error" }),
		}));
		await expect(fundSteward(1, serverError as unknown as typeof fetch)).rejects.not.toBeInstanceOf(
			StewardWithdrawalRejected,
		);
		await expect(fundSteward(1, serverError as unknown as typeof fetch)).rejects.toThrow("HTTP 500");
		// 422 is produced by the route's single catch, which may fire after the broadcast: unknown, never a refusal.
		const unprocessable = vi.fn(async () => ({
			ok: false,
			status: 422,
			json: async () => ({ error: "Steward withdrawal rejected", detail: "receipt wait timed out" }),
		}));
		await expect(fundSteward(1, unprocessable as unknown as typeof fetch)).rejects.not.toBeInstanceOf(
			StewardWithdrawalRejected,
		);
		await expect(fundSteward(1, unprocessable as unknown as typeof fetch)).rejects.toThrow("receipt wait timed out");
		const unconfigured = vi.fn(async () => ({
			ok: false,
			status: 503,
			json: async () => ({ error: "Steward wallet not configured", code: "STEWARD_UNCONFIGURED" }),
		}));
		await expect(fundSteward(1, unconfigured as unknown as typeof fetch)).rejects.toThrow(StewardWithdrawalRejected);
	});

	it("a 422 refusal after a recorded broadcast locks the control (no second POST) and shows the detail", async () => {
		let posts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				posts += 1; // the server broadcast before failing its receipt wait
				return {
					ok: false,
					status: 422,
					json: async () => ({ error: "Steward withdrawal rejected", detail: "receipt wait timed out" }),
				};
			}),
		);
		render(createElement(FinanceReportClient, { report: liveShapedPreview as NodeFinanceSnapshot }));
		const operator = screen.getByRole("table").querySelector<HTMLElement>("tr[data-finance-row='base:operator-wallet']");
		if (!operator) throw new Error("missing operator row");
		const button = () => within(operator).getByRole("button", { name: "Fund steward" });
		await userEvent.click(button());
		const alert = await within(operator).findByRole("alert");
		expect(alert.textContent).toContain("Result unknown");
		expect(alert.textContent).toContain("receipt wait timed out");
		expect((button() as HTMLButtonElement).disabled).toBe(true);
		await userEvent.click(button());
		expect(posts).toBe(1);
		vi.unstubAllGlobals();
	});

	it("shares an unknown outcome and explorer link across desktop and mobile", async () => {
		const post = vi.fn(async () => { throw new Error("lost response"); });
		vi.stubGlobal("fetch", post);
		render(createElement(FinanceReportClient, { report: liveShapedPreview as NodeFinanceSnapshot }));
		const buttons = screen.getAllByRole("button", { name: "Fund steward" });
		await userEvent.click(buttons[0]!);
		for (const button of buttons) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
			await userEvent.click(button);
		}
		expect(post).toHaveBeenCalledTimes(1);
		const mobile = screen.getByRole("region", { name: "Financials list" });
		expect(within(mobile).getByRole("link", { name: "on BaseScan" }).getAttribute("href")).toBe(liveShapedPreview.stewardWalletUrl);
		await userEvent.click(within(mobile).getByRole("button", { name: "I checked" }));
		for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(false);
		vi.unstubAllGlobals();
	});

	it.each([{}, { txHash: transactionHash }, { txHash: null, confirmed: true }, { txHash: "0xabc", confirmed: true }, { txHash: transactionHash, confirmed: "true" }])("treats malformed success as unknown: %j", async (body) => {
		const post = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
		await expect(fundSteward(1, post as unknown as typeof fetch)).rejects.toThrow();
	});

	it("a broadcast without a receipt renders the tx link in a Confirming state", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ txHash: transactionHash, confirmed: false }),
			})),
		);
		render(createElement(FinanceReportClient, { report: liveShapedPreview as NodeFinanceSnapshot }));
		const operator = screen.getByRole("table").querySelector<HTMLElement>("tr[data-finance-row='base:operator-wallet']");
		if (!operator) throw new Error("missing operator row");
		await userEvent.click(within(operator).getByRole("button", { name: "Fund steward" }));
		expect((await within(operator).findByRole("link", { name: /Sent 0xaaaa…7890/ })).getAttribute("href")).toBe(
			`https://basescan.org/tx/${transactionHash}`,
		);
		expect(within(operator).getByText("Confirming…")).toBeTruthy();
		const sendButtons = screen.getAllByRole("button", { name: "Fund steward" });
		expect(sendButtons).toHaveLength(2);
		for (const send of sendButtons) {
			expect((send as HTMLButtonElement).disabled).toBe(true);
			await userEvent.click(send);
		}
		expect(fetch).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});

	it("renders the Next deadline line from the earliest graded row, apart from DAO runway", () => {
		const graded: MoneyPlaneRow = {
			plane: "vendor:demo",
			label: "Demo credit",
			kind: "prepaid",
			balance: 3,
			currency: "USD",
			burnPerDay: 1,
			runwayDays: 3,
			grade: "RED",
			observedAt: takenAt,
			sourceObservedAt: takenAt,
			freshness: "current",
			usd: { amount: 3 },
		};
		const rows = [...liveShapedPreview.rows, graded];
		const report = {
			...liveShapedPreview,
			rows,
			summary: summarize({ rows }, { treasuryPlane: "base:dao-treasury", windowDays: 30 }),
		} as NodeFinanceSnapshot;
		render(createElement(FinanceReportClient, { report }));
		const deadline = document.querySelector("[data-finance-deadline]");
		expect(deadline?.textContent).toBe("Next deadline 3d · Demo credit");
		expect(deadline?.className).toContain("text-destructive");
		// Known hosting/AI gaps prevent a whole-DAO estimate, while the measured deadline stays visible.
		expect(document.querySelector("[data-finance-stat='Runway']")?.textContent).toBe("—");
		expect(screen.getByText("Costs incomplete")).toBeTruthy();
		expect(screen.getByText(/known subtotal · \d+ gaps/)).toBeTruthy();
		expect(document.querySelector("[data-finance-summary]")?.textContent).not.toContain("∞");
	});

	it("a 500 with an error body locks the control like a lost response", async () => {
		let posts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				posts += 1;
				return { ok: false, status: 500, json: async () => ({ error: "Internal server error" }) };
			}),
		);
		render(createElement(FinanceReportClient, { report: liveShapedPreview as NodeFinanceSnapshot }));
		const operator = screen.getByRole("table").querySelector<HTMLElement>("tr[data-finance-row='base:operator-wallet']");
		if (!operator) throw new Error("missing operator row");
		const button = () => within(operator).getByRole("button", { name: "Fund steward" });
		await userEvent.click(button());
		const alert = await within(operator).findByRole("alert");
		expect(alert.textContent).toContain("Result unknown");
		expect((button() as HTMLButtonElement).disabled).toBe(true);
		expect(button().getAttribute("aria-describedby")).toBe(alert.id);
		await userEvent.click(button());
		expect(posts).toBe(1);
		vi.unstubAllGlobals();
	});

	it("an accepted transfer with a lost response locks the control: no second POST until the user confirms the check", async () => {
		let posts = 0;
		const fetchSpy = vi.fn(async () => {
			posts += 1;
			return {
				ok: true,
				status: 200,
				json: async () => {
					throw new Error("lost");
				},
			};
		});
		vi.stubGlobal("fetch", fetchSpy);
		render(createElement(FinanceReportClient, { report: liveShapedPreview as NodeFinanceSnapshot }));
		const operator = screen.getByRole("table").querySelector<HTMLElement>("tr[data-finance-row='base:operator-wallet']");
		if (!operator) throw new Error("missing operator row");
		const button = () => within(operator).getByRole("button", { name: "Fund steward" });
		await userEvent.click(button());
		const alert = await within(operator).findByRole("alert");
		expect(alert.textContent).toMatch(/^Result unknown \(Response unreadable \(HTTP 200\)\) — check the steward wallet/);
		expect(within(operator).getByRole("link", { name: /on BaseScan/ }).getAttribute("href")).toBe(
			liveShapedPreview.stewardWalletUrl,
		);
		expect((button() as HTMLButtonElement).disabled).toBe(true);
		await userEvent.click(button());
		expect(posts).toBe(1);
		await userEvent.click(within(operator).getByRole("button", { name: "I checked" }));
		expect((button() as HTMLButtonElement).disabled).toBe(false);
		vi.unstubAllGlobals();
	});

	it("the inline control posts the typed amount and links the broadcast tx", async () => {
		const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ txHash: transactionHash, confirmed: true }) }));
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
		expect((await within(operator).findByRole("link", { name: /Sent 0xaaaa…7890/ })).getAttribute("href")).toBe(
			`https://basescan.org/tx/${transactionHash}`,
		);
		vi.unstubAllGlobals();
	});
});
