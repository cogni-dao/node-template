// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Caller deadlines abandon ownership, while admission stays held until native
 * settlement. Shared by SQL batches and the coalesced goal-progress read. */
import type { Sql } from "postgres";
import { MetricError } from "../contracts.js";
const active = new WeakMap<object, number>();
export async function readMetricBudget<T>(
	owner: object,
	signal: AbortSignal | undefined,
	read: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
	if (signal?.aborted || (active.get(owner) ?? 0) >= 4)
		throw new MetricError("batch_unavailable", 503);
	active.set(owner, (active.get(owner) ?? 0) + 1);
	const controller = new AbortController();
	let rejectCaller: (error: Error) => void = () => {};
	const stop = () => {
		if (controller.signal.aborted) return;
		controller.abort();
		rejectCaller(new MetricError("batch_unavailable", 503));
	};
	const deadline = new Promise<never>((_, reject) => {
		rejectCaller = reject;
	});
	const timer = setTimeout(stop, 2500);
	signal?.addEventListener("abort", stop, { once: true });
	const native = Promise.resolve()
		.then(() => {
			controller.signal.throwIfAborted();
			return read(controller.signal);
		})
		.finally(() => {
			active.set(owner, (active.get(owner) ?? 1) - 1);
		});
	try {
		return await Promise.race([native, deadline]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}
}

/** Native postgres.js cancellation and transaction timeout; a rejected caller
 * never releases capacity before the transaction actually settles. */
export function readMetricBatch<T>(
	pool: Sql,
	signal: AbortSignal | undefined,
	read: (sql: Sql) => PromiseLike<T> & { cancel?(): void | Promise<unknown> },
): Promise<T> {
	return readMetricBudget(
		pool,
		signal,
		async (boundedSignal) =>
			pool.begin(async (tx) => {
				await tx.unsafe("SET LOCAL statement_timeout=2000");
				boundedSignal.throwIfAborted();
				const query = read(tx as unknown as Sql);
				const cancel = () => {
					void Promise.resolve(query.cancel?.()).catch(() => undefined);
				};
				boundedSignal.addEventListener("abort", cancel, { once: true });
				try {
					const result = await query;
					boundedSignal.throwIfAborted();
					return result;
				} finally {
					boundedSignal.removeEventListener("abort", cancel);
				}
			}) as Promise<T>,
	);
}
