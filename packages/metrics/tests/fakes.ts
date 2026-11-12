// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Test doubles shared by the no-inline-history and definition tests: a fake Sql and an in-memory observation store. */
import type { Sql } from "postgres";
import { createGoalMetrics } from "../src/knowledge.js";

export type Row = Record<string, unknown>;

/** Fake Sql whose `unsafe` answers from a function and records every statement. */
export function fakeSql(answer: (text: string) => Row[] | Promise<Row[]>) {
	const queries: string[] = [];
	const sql = {
		begin: async (fn: (tx: unknown) => unknown) => fn(sql),
		unsafe(text: string) {
			queries.push(text);
			const p = Promise.resolve().then(() => answer(text));
			return Object.assign(p, { cancel: () => undefined });
		},
	} as unknown as Sql;
	return { sql, queries };
}

/** In-memory stand-in for the observation adapter's tagged-template SQL. */
export function memoryObservations() {
	let row: Row | undefined;
	const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?");
		if (text.startsWith("WITH requested AS"))
			return Promise.resolve(JSON.parse(String(values[0])).map(() => ({})));
		if (text.startsWith("INSERT INTO execution_requests"))
			return Promise.resolve([{ run_id: values[2] }]);
		if (text.startsWith("INSERT INTO metric_observations")) {
			row = { id: values[0], snapshot: values[6], observation: values[7] };
			return Promise.resolve([row]);
		}
		if (text.startsWith("UPDATE metric_observations SET lease_token"))
			return Promise.resolve(row ? [row] : []);
		if (text.startsWith("UPDATE metric_observations SET observation="))
			return Promise.resolve([{ observation: values[0] }]);
		return Promise.resolve([]);
	}) as unknown as Sql & { begin: unknown };
	Object.assign(sql, {
		unsafe: async () => [],
		begin: (fn: (tx: Sql) => Promise<unknown>) => fn(sql),
	});
	return sql;
}
export const noObservations = Object.assign(
	(strings: TemplateStringsArray, ...values: unknown[]) =>
		Promise.resolve(
			strings.join("?").startsWith("WITH requested AS")
				? JSON.parse(String(values[0])).map(() => ({}))
				: [],
		),
	{
		unsafe: async () => [],
		begin: async (fn: (tx: unknown) => unknown): Promise<unknown> =>
			fn(noObservations),
	},
) as unknown as Sql;

/** A hub row that is a metric definition. */
export const metricRow = (
	id: string,
	calculatorId: string,
	params: unknown,
	extra: Row = {},
): Row => ({
	id,
	title: id,
	metric_spec: {
		calculatorId,
		params,
		cadenceSeconds: 3600,
		maxAgeSeconds: 7200,
	},
	updated_at: "2026-11-01T00:00:00Z",
	status: "active",
	...extra,
});

/**
 * A hub that answers the definition reads from `hubRows` and every other
 * statement from `answer`. `service` writes observations in memory; `reader`
 * has none, for registry and definition reads.
 */
export function hub(
	hubRows: Row[],
	answer: (text: string) => Row[] = () => [],
) {
	const events: object[] = [];
	const knowledge = fakeSql((text) => {
		if (!/^SELECT id,title,metric_spec,updated_at FROM knowledge/.test(text))
			return answer(text);
		const one = /WHERE id='([^']+)'/.exec(text)?.[1];
		if (one)
			return hubRows.filter(
				(r) =>
					r.id === one && r.metric_spec != null && r.status !== "deprecated",
			);
		const after = /AND id > '([^']+)'/.exec(text)?.[1];
		const limit = Number(/LIMIT (\d+)/.exec(text)?.[1] ?? 50);
		return hubRows
			.filter((r) => r.metric_spec != null && r.status !== "deprecated")
			.filter((r) => !after || String(r.id) > after)
			.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
			.slice(0, limit);
	});
	const base = {
		knowledgeSql: knowledge.sql,
		node: "node-template",
		environment: "test",
		log: (event: object) => events.push(event),
	};
	return {
		service: createGoalMetrics({
			...base,
			observationsSql: memoryObservations(),
		}),
		reader: createGoalMetrics({ ...base, observationsSql: noObservations }),
		events,
		queries: knowledge.queries,
	};
}
