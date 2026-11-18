// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * One refresh tick reads each identical source statement once. Calculators that
 * share a source (convergence ratio, validated and created)
 * issue the same static SQL for the same window, so inside a tick scope the first
 * caller runs it and the others await the same rows. Outside a tick scope, and for
 * parameterized statements, every call goes straight to the client.
 *
 * Cancellation stays owned: the shared query is cancelled only when every waiter
 * that is still pending cancels. Waiters already sharing a failing statement get
 * its error; the failure then leaves the scope, so a later caller retries it.
 * The returned value supports `await` and `cancel()` only, which is all the
 * source readers use.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Sql } from "postgres";

type Rows = ReadonlyArray<Record<string, unknown>>;
interface Shared {
	query: { cancel(): unknown };
	promise: Promise<Rows>;
	pending: number;
}

interface SharedOnce<T = unknown> {
	controller: AbortController;
	promise: Promise<T>;
	pending: number;
}

export function createTickReads() {
	const scope = new AsyncLocalStorage<Map<string, Shared>>();
	const once = new AsyncLocalStorage<Map<string, SharedOnce>>();
	return {
		/** Run `fn` with one shared-statement scope. */
		run<T>(fn: () => Promise<T>): Promise<T> {
			return scope.run(new Map(), () => once.run(new Map(), fn));
		},
		/**
		 * Inside `run`, the first caller of `key` performs `fn` and later callers
		 * await the same result; outside it every call performs `fn`. The shared
		 * read has its own signal, aborted only when every waiter still pending
		 * aborts. A failed read leaves the scope so a later caller retries. The
		 * scope ends with the tick, so nothing outlives it.
		 */
		shareOnce<T>(
			key: string,
			fn: (signal: AbortSignal) => Promise<T>,
			signal: AbortSignal,
		): Promise<T> {
			const memo = once.getStore();
			if (!memo) return fn(signal);
			let shared = memo.get(key) as SharedOnce<T> | undefined;
			if (!shared) {
				const controller = new AbortController();
				const created: SharedOnce<T> = {
					controller,
					promise: fn(controller.signal),
					pending: 0,
				};
				created.promise.catch(() => {
					if (memo.get(key) === created) memo.delete(key);
				});
				memo.set(key, created as SharedOnce);
				shared = created;
			}
			const s = shared;
			s.pending++;
			return new Promise<T>((resolve, reject) => {
				const abandon = () => {
					s.pending = Math.max(0, s.pending - 1);
					if (s.pending === 0) {
						if (memo.get(key) === s) memo.delete(key);
						s.controller.abort();
					}
					reject(signal.reason ?? new Error("aborted"));
				};
				if (signal.aborted) return abandon();
				signal.addEventListener("abort", abandon, { once: true });
				s.promise.then(
					(value) => {
						signal.removeEventListener("abort", abandon);
						resolve(value);
					},
					(error: unknown) => {
						signal.removeEventListener("abort", abandon);
						reject(error);
					},
				);
			});
		},
		/** A client whose `unsafe(text)` shares identical statements inside `run`. */
		share(sql: Sql): Sql {
			return new Proxy(sql, {
				get(target, prop, receiver) {
					if (prop !== "unsafe") return Reflect.get(target, prop, receiver);
					return (text: string, ...rest: unknown[]) => {
						const memo = scope.getStore();
						if (!memo || rest.length)
							return (target.unsafe as (...a: unknown[]) => unknown)(
								text,
								...rest,
							);
						let shared = memo.get(text);
						if (!shared) {
							const query = target.unsafe(text);
							const created: Shared = {
								query,
								promise: Promise.resolve(query as unknown as Promise<Rows>),
								pending: 0,
							};
							created.promise.catch(() => {
								if (memo.get(text) === created) memo.delete(text);
							});
							memo.set(text, created);
							shared = created;
						}
						const s = shared;
						s.pending++;
						let open = true;
						const settle = () => {
							if (open) {
								open = false;
								s.pending = Math.max(0, s.pending - 1);
							}
						};
						const result = s.promise.then(
							(rows) => {
								settle();
								return rows;
							},
							(error: unknown) => {
								settle();
								throw error;
							},
						);
						return Object.assign(result, {
							cancel() {
								if (!open) return;
								settle();
								if (s.pending === 0) {
									if (memo.get(text) === s) memo.delete(text);
									void s.query.cancel();
								}
							},
						});
					};
				},
			}) as Sql;
		},
	};
}
