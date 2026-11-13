// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createTickReads } from "../src/tick-reads.js";

function fakeSql() {
	const calls: string[] = [];
	const cancels: string[] = [];
	let fail = false;
	const sql = {
		unsafe(text: string, ...rest: unknown[]) {
			calls.push(rest.length ? `${text}#params` : text);
			let settle: (rows: unknown[]) => void = () => {};
			let reject: (e: unknown) => void = () => {};
			const promise = new Promise<unknown[]>((res, rej) => {
				settle = res;
				reject = rej;
			});
			queueMicrotask(() => (fail ? reject(new Error("boom")) : settle([{ text }])));
			return Object.assign(promise, {
				cancel() {
					cancels.push(text);
				},
			});
		},
	} as unknown as Sql;
	return { sql, calls, cancels, failNext: (v: boolean) => (fail = v) };
}

describe("tick-shared source statements", () => {
	it("runs an identical statement once inside a tick and every time outside", async () => {
		const f = fakeSql();
		const tick = createTickReads();
		const shared = tick.share(f.sql);
		await tick.run(async () => {
			const [a, b] = await Promise.all([
				shared.unsafe("SELECT 1"),
				shared.unsafe("SELECT 1"),
			]);
			expect(a).toEqual(b);
			await shared.unsafe("SELECT 1");
			await shared.unsafe("SELECT 2");
		});
		await shared.unsafe("SELECT 1");
		await tick.run(() => shared.unsafe("SELECT 1"));
		expect(f.calls).toEqual(["SELECT 1", "SELECT 2", "SELECT 1", "SELECT 1"]);
	});
	it("never shares parameterized statements or failures", async () => {
		const f = fakeSql();
		const tick = createTickReads();
		const shared = tick.share(f.sql);
		await tick.run(async () => {
			await (shared.unsafe as (...a: unknown[]) => Promise<unknown>)("SELECT $1", [1]);
			await (shared.unsafe as (...a: unknown[]) => Promise<unknown>)("SELECT $1", [1]);
			f.failNext(true);
			await expect(shared.unsafe("SELECT 3")).rejects.toThrow("boom");
			f.failNext(false);
			await expect(shared.unsafe("SELECT 3")).resolves.toEqual([{ text: "SELECT 3" }]);
		});
		expect(f.calls).toEqual([
			"SELECT $1#params",
			"SELECT $1#params",
			"SELECT 3",
			"SELECT 3",
		]);
	});
	it("cancels the shared query only when every pending waiter cancels", async () => {
		const f = fakeSql();
		const tick = createTickReads();
		const shared = tick.share(f.sql);
		await tick.run(async () => {
			const a = shared.unsafe("SELECT 4") as unknown as { cancel(): void };
			const b = shared.unsafe("SELECT 4") as unknown as { cancel(): void };
			a.cancel();
			expect(f.cancels).toEqual([]);
			b.cancel();
			expect(f.cancels).toEqual(["SELECT 4"]);
			await Promise.allSettled([a, b]);
			// The cancelled statement left the scope: the next caller runs it again.
			await shared.unsafe("SELECT 4");
		});
		expect(f.calls).toEqual(["SELECT 4", "SELECT 4"]);
	});
});
