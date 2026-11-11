// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/metrics/http`
 * Purpose: Framework-neutral core of the /api/v1/metrics/* routes: parse the
 *   request pieces, call the injected service, validate the response with the
 *   wire contracts and map every failure to one HTTP status and error code.
 * Scope: Pure over injected ports. No Next.js, no node bootstrap, no logging
 *   sink. A node route keeps only authentication, path parameters, request
 *   logging and turning a result into its framework's response.
 * Invariants: ONE_WIRE_CONTRACT (every success body is parsed by the contract
 *   schema); TYPED_ERRORS (a MetricError keeps its code and status; anything
 *   else is `metrics_unavailable` 503 and is reported through
 *   `onUnexpectedError`, never to the caller); INVALID_INPUT_IS_400;
 *   SERVES_BESIDE_SPEC (the view carries `serves`, `band` and `bandAssessment`
 *   from the contract schema; they sit beside the hashed spec, so a metric
 *   outside any goal can read red).
 * Side-effects: none beyond the injected service and subject reader.
 * Links: ./contracts.ts, ./index.ts (MetricService), packages/metrics/AGENTS.md
 * @public
 */

import {
	type GoalsProgress,
	GoalsProgressSchema,
	KpiBindingsSchema,
	MetricComputeInputSchema,
	MetricError,
	MetricHistoryInputSchema,
	MetricHistorySchema,
	MetricListInputSchema,
	MetricListResponseSchema,
	MetricObservationSchema,
	MetricReadResponseSchema,
	MetricSnapshotSchema,
	MetricViewSchema,
} from "./contracts.js";
import type { MetricService } from "./index.js";

/** Every metrics response is per-caller live data. */
export const METRIC_HTTP_HEADERS = { "Cache-Control": "no-store" } as const;

export interface MetricHttpErrorBody {
	readonly error: string;
	readonly issues?: readonly unknown[];
}

/** `ok` narrows `body`: a success carries the contract shape, a failure `{ error }`. */
export type MetricHttpResult<T = unknown> =
	| { readonly ok: true; readonly status: 200 | 409; readonly body: T }
	| {
			readonly ok: false;
			readonly status: number;
			readonly body: MetricHttpErrorBody;
	  };

/** The subset of the metric service the routes call. */
export type MetricRouteService = Pick<
	MetricService,
	| "list"
	| "read"
	| "history"
	| "historyRange"
	| "observation"
	| "compute"
	| "bindings"
>;

/** A goal or hypothesis entry a node resolves for the subject projection. */
export interface MetricSubjectRow {
	readonly id: string;
	readonly title: string;
	readonly entryType?: string | null | undefined;
	readonly kpiBindings?: unknown;
	readonly evaluateAt?: Date | null | undefined;
}

export interface MetricHttpPorts {
	/** The same reader instance the goal-progress agent tool uses. */
	goalProgress(): Promise<GoalsProgress>;
	/** Undefined when the node has no metrics service: every read answers 503. */
	service(): MetricRouteService | undefined;
	/** The knowledge entry behind a subject id, or null/undefined when absent. */
	subject(id: string): Promise<MetricSubjectRow | null | undefined>;
	/** Called with the original error before a 503 is returned. */
	onUnexpectedError?(error: unknown): void;
}

const OBSERVATION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT_TYPES = ["goal", "hypothesis"];

function ok<T>(body: T, status: 200 | 409 = 200): MetricHttpResult<T> {
	return { ok: true, status, body };
}
function fail(
	status: number,
	error: string,
	issues?: readonly unknown[],
): MetricHttpResult<never> {
	return { ok: false, status, body: issues ? { error, issues } : { error } };
}

/** One error to one status; unexpected failures never leak a message. */
export function metricErrorResult(
	error: unknown,
	onUnexpectedError?: (error: unknown) => void,
): MetricHttpResult<never> {
	if (error instanceof MetricError) return fail(error.status, error.code);
	onUnexpectedError?.(error);
	return fail(503, "metrics_unavailable");
}

export function createMetricHttpHandlers(ports: MetricHttpPorts) {
	const service = (): MetricRouteService => {
		const s = ports.service();
		if (!s) throw new MetricError("metrics_unavailable", 503);
		return s;
	};
	const guard =
		<A extends unknown[], T>(
			run: (...args: A) => Promise<MetricHttpResult<T>>,
		) =>
		async (...args: A): Promise<MetricHttpResult<T>> => {
			try {
				return await run(...args);
			} catch (error) {
				return metricErrorResult(error, ports.onUnexpectedError);
			}
		};

	return {
		/** GET /api/v1/metrics/goals */
		goals: guard(async () =>
			ok(GoalsProgressSchema.parse(await ports.goalProgress())),
		),

		/** GET /api/v1/metrics?limit=&after= */
		list: guard(async (query: URLSearchParams) => {
			const input = MetricListInputSchema.safeParse({
				...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
				...(query.has("after") ? { after: query.get("after") } : {}),
			});
			if (!input.success) return fail(400, "invalid_input");
			const s = service();
			return ok(
				MetricListResponseSchema.parse(
					await s.list(input.data.limit, input.data.after),
				),
			);
		}),

		/** GET /api/v1/metrics/{id}: the view plus its recent history. */
		read: guard(async (id: string) => {
			const s = service();
			const view = MetricViewSchema.parse(await s.read(id));
			const history = (await s.history(id)).map((x) =>
				MetricObservationSchema.parse(x),
			);
			return ok(MetricReadResponseSchema.parse({ ...view, history }));
		}),

		/** GET /api/v1/metrics/{id}/history?from=&to=&step= */
		history: guard(async (id: string, query: URLSearchParams) => {
			const input = MetricHistoryInputSchema.safeParse({
				from: query.get("from") ?? undefined,
				to: query.get("to") ?? undefined,
				step: query.get("step") ?? undefined,
			});
			if (!input.success)
				return fail(400, "invalid_input", input.error.issues);
			return ok(
				MetricHistorySchema.parse(await service().historyRange(id, input.data)),
			);
		}),

		/** GET /api/v1/metrics/{id}/observations/{observationId} */
		observation: guard(async (id: string, observationId: string) => {
			if (!OBSERVATION_ID.test(observationId))
				return fail(400, "invalid_observation_id");
			return ok(
				MetricSnapshotSchema.parse(
					await service().observation(id, observationId),
				),
			);
		}),

		/** POST /api/v1/metrics/{id}/compute; `readJson` rejects on a malformed body. */
		compute: guard(async (id: string, readJson: () => Promise<unknown>) => {
			let body: unknown;
			try {
				body = await readJson();
			} catch {
				return fail(400, "invalid_json");
			}
			const input = MetricComputeInputSchema.safeParse(body);
			if (!input.success)
				return fail(400, "invalid_input", input.error.issues);
			const result = MetricObservationSchema.parse(
				await service().compute(id, input.data),
			);
			return ok(result, result.status === "pending" ? 409 : 200);
		}),

		/** GET /api/v1/metrics/subjects/{id}: a goal's or hypothesis' KPI readings. */
		subject: guard(async (id: string) => {
			const row = await ports.subject(id);
			if (!row || !SUBJECT_TYPES.includes(row.entryType ?? ""))
				throw new MetricError("subject_not_found", 404);
			const bindings = KpiBindingsSchema.parse(row.kpiBindings ?? []);
			return ok({
				id: row.id,
				title: row.title,
				entryType: row.entryType,
				kpis: await service().bindings(bindings, {
					hypothesis: row.entryType === "hypothesis",
					deadline: row.evaluateAt?.toISOString() ?? null,
				}),
			});
		}),
	};
}

export type MetricHttpHandlers = ReturnType<typeof createMetricHttpHandlers>;
