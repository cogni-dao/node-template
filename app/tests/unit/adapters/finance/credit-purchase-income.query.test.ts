// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `tests/unit/adapters/finance/credit-purchase-income.query`
 * Purpose: Prove the income query is built on the payment_attempts status index, joins payment_events only for the
 *   CREDITED timestamp, bounds the window on that event time, aggregates in SQL, and honours the reader's signal.
 * Scope: Real Drizzle query builder over the pg-proxy driver with a recording callback; no database.
 * Invariants: Reverting to intent time (payment_attempts.created_at) fails this test.
 * Side-effects: none
 * Links: src/adapters/server/finance/credit-purchase-income.query.ts
 * @internal
 */
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";

import type { Database } from "@/adapters/server/db/client";
import {
	CREDITED_STATUS,
	creditedPurchasesQuery,
} from "@/adapters/server/finance/credit-purchase-income.query";

function recordingDb() {
	const calls: { sql: string; params: unknown[]; method: string }[] = [];
	const db = drizzle(async (sql, params, method) => {
		calls.push({ sql, params, method });
		return { rows: [["4500", "3"]] };
	});
	return { db: db as unknown as Database, calls };
}

describe("creditedPurchasesQuery", () => {
	it("drives from payment_attempts.status, joins the CREDITED event for its time, bounds on that time, and aggregates", async () => {
		const { db, calls } = recordingDb();
		const since = new Date("2026-09-26T00:00:00.000Z");
		const totals = await creditedPurchasesQuery(db)(since, new AbortController().signal);
		expect(totals).toEqual({ totalUsdCents: 4500, count: 3 });
		expect(calls).toHaveLength(1);
		const sql = calls[0]?.sql.replace(/\s+/g, " ") ?? "";
		const params = calls[0]?.params ?? [];
		expect(sql).toMatch(/from "payment_attempts"/);
		expect(sql).toMatch(/inner join "payment_events" on \("payment_events"\."attempt_id" = "payment_attempts"\."id" and "payment_events"\."to_status" = \$\d\)/);
		expect(sql).toMatch(/"payment_attempts"\."status" = \$\d/);
		expect(sql).toMatch(/"payment_events"\."created_at" >= \$\d/);
		expect(sql).not.toMatch(/"payment_attempts"\."created_at"/);
		expect(sql).toMatch(/coalesce\(sum\("payment_attempts"\."amount_usd_cents"\), 0\)/);
		expect(sql).toMatch(/count\(\*\)/);
		expect(params.filter((p) => p === CREDITED_STATUS)).toHaveLength(2);
		expect(params.some((p) => p instanceof Date && p.getTime() === since.getTime() || p === since.toISOString())).toBe(true);
	});
	it("does not query once the reader's budget has already expired", async () => {
		const { db, calls } = recordingDb();
		const controller = new AbortController();
		controller.abort();
		await expect(creditedPurchasesQuery(db)(new Date(), controller.signal)).rejects.toThrow("income query aborted");
		expect(calls).toHaveLength(0);
	});
});
