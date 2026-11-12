// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Same postgres.js cancellation and native transaction timeout used by metric
 * sources/reservations. Admission remains held until native settlement, even
 * after the caller's deadline; cancellation connections are bounded by admission. */
import type { Sql } from "postgres";
import { MetricError } from "../contracts.js";
const active = new WeakMap<object, number>();
export async function readMetricBatch<T>(
	pool: Sql,
	signal: AbortSignal | undefined,
	read: (sql: Sql) => PromiseLike<T> & { cancel?(): void | Promise<unknown> },
): Promise<T> {
	if (signal?.aborted || (active.get(pool) ?? 0) >= 4)
		throw new MetricError("batch_unavailable", 503);
	active.set(pool, (active.get(pool) ?? 0) + 1);
	const controller = new AbortController();
	let cancel: (() => void) | undefined;
	let rejectCaller: (error: Error) => void = () => {};
	const stop = () => {
		if (controller.signal.aborted) return;
		controller.abort();
		cancel?.();
		rejectCaller(new MetricError("batch_unavailable", 503));
	};
	const deadline = new Promise<never>((_, reject) => {
		rejectCaller = reject;
	});
	const timer = setTimeout(stop, 2500);
	signal?.addEventListener("abort", stop, { once: true });
	const native = (async () =>
		pool.begin(async (tx) => {
			await tx.unsafe("SET LOCAL statement_timeout=2000");
			controller.signal.throwIfAborted();
			const query = read(tx as unknown as Sql);
			cancel = () => {
				void Promise.resolve(query.cancel?.()).catch(() => undefined);
			};
			if (controller.signal.aborted) cancel();
			const result = await query;
			controller.signal.throwIfAborted();
			return result;
		}))().finally(() => {
		active.set(pool, (active.get(pool) ?? 1) - 1);
	});
	try {
		return (await Promise.race([native, deadline])) as T;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}
}
