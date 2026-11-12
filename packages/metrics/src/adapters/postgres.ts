// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Scoped injected SQL. Snapshot reservation precedes I/O; completed observations never change. */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { HISTORY_ORIGIN_MS, metricHistoryRange } from "../assess.js";
import {
	MetricError,
	type MetricHistoryInput,
	MetricObservationSchema,
	type MetricObservationsPort,
	type MetricScope,
	type MetricSnapshot,
} from "../contracts.js";

type Row = Record<string, unknown>;
/** `dolt:head:<32-char hash>@<toISOString()>`; only matching refs are cast to a time. */
const HEAD_REF =
	"^dolt:head:[a-z0-9]{32}@[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$";
function json(value: unknown) {
	return typeof value === "string" ? JSON.parse(value) : value;
}
export class PostgresMetricObservations implements MetricObservationsPort {
	constructor(
		private readonly sql: Sql,
		private readonly scope: MetricScope,
	) {}
	private get key() {
		return `${this.scope.node}/${this.scope.environment}/${this.scope.dataScope}`;
	}
	async predictionReadBatch(
		requests: readonly {
			metricId: string;
			baselineObservationId: string;
			evaluationAt: string;
		}[],
	) {
		if (!requests.length) return [];
		if (requests.length > 100) throw new MetricError("too_many_metrics", 400);
		const rows = await this
			.sql`WITH requested AS (SELECT ord, value->>'metricId' AS metric_id, value->>'baselineObservationId' AS baseline_id, value->>'evaluationAt' AS due FROM jsonb_array_elements(${JSON.stringify(requests)}::text::jsonb) WITH ORDINALITY AS x(value,ord))
		SELECT b.snapshot AS baseline_definition, b.observation AS baseline_observation, l.observation AS latest_observation, g.observation AS good_observation, e.observation AS evaluation_observation
		FROM requested r LEFT JOIN metric_observations b ON b.scope=${this.key} AND b.id=CASE WHEN r.baseline_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN r.baseline_id::uuid ELSE NULL END AND b.metric_id=r.metric_id
		LEFT JOIN LATERAL (SELECT observation FROM metric_observations WHERE scope=${this.key} AND metric_id=r.metric_id AND definition_hash=b.definition_hash ORDER BY evaluation_at DESC,id DESC LIMIT 1) l ON true
		LEFT JOIN LATERAL (SELECT observation FROM metric_observations WHERE scope=${this.key} AND metric_id=r.metric_id AND definition_hash=b.definition_hash AND status='ok' ORDER BY evaluation_at DESC,id DESC LIMIT 1) g ON true
		LEFT JOIN LATERAL (SELECT observation FROM metric_observations WHERE scope=${this.key} AND metric_id=r.metric_id AND definition_hash=b.definition_hash AND status='ok' AND observation->'value' IS NOT NULL AND jsonb_typeof(observation->'value')='number' AND evaluation_at <= r.due::timestamptz AND evaluation_at >= r.due::timestamptz - ((b.snapshot->'spec'->>'maxAgeSeconds')::int * interval '1 second') AND (observation->>'observedAt')::timestamptz <= r.due::timestamptz + ((b.snapshot->'spec'->>'maxAgeSeconds')::int * interval '1 second') ORDER BY evaluation_at DESC,(observation->>'observedAt')::timestamptz DESC,id DESC LIMIT 1) e ON true ORDER BY r.ord`;
		const parse = (value: unknown) =>
			value ? MetricObservationSchema.parse(json(value)) : null;
		return rows.map((row) => ({
			baseline: row.baseline_observation
				? ({
						definition: json(row.baseline_definition),
						observation: MetricObservationSchema.parse(
							json(row.baseline_observation),
						),
					} as MetricSnapshot)
				: null,
			latest: parse(row.latest_observation),
			lastGood: parse(row.good_observation),
			evaluation: parse(row.evaluation_observation),
		}));
	}
	async request(metricId: string, requestKey: string, requestHash: string) {
		const key = `metric/${this.key}/${metricId}/${requestKey}`;
		const [receipt] = await this
			.sql`SELECT request_hash,run_id FROM execution_requests WHERE idempotency_key=${key}`;
		if (!receipt) return null;
		if (receipt.request_hash !== requestHash)
			throw new MetricError("idempotency_conflict", 422);
		const snapshot = await this.snapshot(String(receipt.run_id));
		if (!snapshot) throw new MetricError("observation_missing", 503);
		return snapshot;
	}
	async reserve(input: Parameters<MetricObservationsPort["reserve"]>[0]) {
		return this.sql.begin(async (tx) => {
			await tx`SET LOCAL statement_timeout = '5s'`;
			const key = `metric/${this.key}/${input.snapshot.definition.id}/${input.requestKey}`;
			const candidate = input.snapshot.observation;
			const receipt =
				await tx`INSERT INTO execution_requests (idempotency_key,request_hash,run_id)
        VALUES (${key},${input.requestHash},${candidate.id}) ON CONFLICT DO NOTHING RETURNING run_id`;
			let row: Row | undefined;
			if (receipt.length) {
				const created =
					await tx`INSERT INTO metric_observations (id,scope,metric_id,definition_hash,evaluation_at,scheduled_for,snapshot,observation,status)
          VALUES (${candidate.id},${this.key},${candidate.metricId},${candidate.definitionHash},${candidate.window.end},${candidate.scheduledFor ?? null},
          ${JSON.stringify(input.snapshot.definition)}::text::jsonb,${JSON.stringify(candidate)}::text::jsonb,'pending')
          ON CONFLICT (scope,metric_id,definition_hash,evaluation_at) DO NOTHING RETURNING *`;
				row = created[0];
				if (!row)
					[row] =
						await tx`SELECT * FROM metric_observations WHERE scope=${this.key} AND metric_id=${candidate.metricId} AND definition_hash=${candidate.definitionHash} AND evaluation_at=${candidate.window.end}`;
				if (!row) throw new MetricError("observation_missing", 503);
				await tx`UPDATE execution_requests SET run_id=${String(row.id)} WHERE idempotency_key=${key}`;
			} else {
				const [previous] =
					await tx`SELECT request_hash,run_id FROM execution_requests WHERE idempotency_key=${key}`;
				if (previous?.request_hash !== input.requestHash)
					throw new MetricError("idempotency_conflict", 422);
				[row] =
					await tx`SELECT * FROM metric_observations WHERE id=${String(previous.run_id)} AND scope=${this.key}`;
			}
			if (!row) throw new MetricError("observation_missing", 503);
			// A snapshot measures its original instant. Never reclaim an expired
			// attempt and read today's source under yesterday's evidence window.
			const [expired] =
				await tx`UPDATE metric_observations SET status='error',lease_token=NULL,lease_expires_at=NULL,
        observation=observation || jsonb_build_object('status','error','reason','lease_expired','observedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        WHERE id=${String(row.id)} AND scope=${this.key} AND status='pending' AND lease_expires_at<=clock_timestamp() RETURNING *`;
			if (expired) row = expired;
			const token = randomUUID();
			const [claimed] =
				await tx`UPDATE metric_observations SET lease_token=${token},lease_expires_at=clock_timestamp()+(${input.leaseMs} * interval '1 millisecond')
        WHERE id=${String(row.id)} AND scope=${this.key} AND status='pending' AND lease_expires_at IS NULL RETURNING *`;
			// Another transaction may have completed/expired the attempt while
			// UPDATE waited. Read its terminal state rather than the stale row.
			const [current] = claimed
				? [claimed]
				: await tx`SELECT * FROM metric_observations WHERE id=${String(row.id)} AND scope=${this.key}`;
			const chosen = current ?? row;
			return {
				snapshot: {
					definition: json(chosen.snapshot),
					observation: MetricObservationSchema.parse(json(chosen.observation)),
				} as MetricSnapshot,
				leaseToken: claimed ? token : null,
			};
		});
	}
	async complete(
		id: string,
		token: string,
		result: Parameters<MetricObservationsPort["complete"]>[2],
	) {
		const [row] = await this
			.sql`UPDATE metric_observations SET observation=${JSON.stringify(result)}::text::jsonb,status=${result.status},lease_token=NULL,lease_expires_at=NULL
      WHERE id=${id} AND scope=${this.key} AND status='pending' AND lease_token=${token} AND lease_expires_at>clock_timestamp() RETURNING observation`;
		if (!row) return null;
		return MetricObservationSchema.parse(json(row.observation));
	}
	async history(metricId: string, definitionHash: string, limit: number) {
		const rows = await this
			.sql`SELECT observation FROM metric_observations WHERE scope=${this.key} AND metric_id=${metricId} AND definition_hash=${definitionHash}
      ORDER BY evaluation_at DESC,id DESC LIMIT ${Math.min(100, Math.max(1, limit))}`;
		return rows.map((row) =>
			MetricObservationSchema.parse(json(row.observation)),
		);
	}
	async workReadBatch(
		requests: readonly {
			metricId: string;
			definitionHash: string;
			baselineObservationId: string | null;
		}[],
	) {
		if (!requests.length) return [];
		if (requests.length > 300) throw new MetricError("too_many_metrics", 400);
		const rows = await this
			.sql`WITH requested AS (SELECT ord, value->>'metricId' AS "metricId", value->>'definitionHash' AS "definitionHash", value->>'baselineObservationId' AS "baselineObservationId" FROM jsonb_array_elements(${JSON.stringify(requests)}::text::jsonb) WITH ORDINALITY AS x(value,ord))
		SELECT r."metricId" AS metric_id, r."baselineObservationId" AS baseline_id,
		 b.snapshot AS baseline_definition, b.observation AS baseline_observation, l.observation AS latest_observation
		FROM requested r LEFT JOIN metric_observations b ON b.scope=${this.key} AND b.id=CASE WHEN r."baselineObservationId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN r."baselineObservationId"::uuid ELSE NULL END
		LEFT JOIN LATERAL (SELECT observation FROM metric_observations WHERE scope=${this.key} AND metric_id=r."metricId" AND definition_hash=r."definitionHash" ORDER BY evaluation_at DESC,id DESC LIMIT 1) l ON true ORDER BY r.ord`;
		return rows.map((row) => ({
			baseline: row.baseline_observation
				? ({
						definition: json(row.baseline_definition),
						observation: MetricObservationSchema.parse(
							json(row.baseline_observation),
						),
					} as MetricSnapshot)
				: null,
			latest: row.latest_observation
				? MetricObservationSchema.parse(json(row.latest_observation))
				: null,
		}));
	}
	async get(id: string) {
		const [row] = await this
			.sql`SELECT observation FROM metric_observations WHERE id=${id} AND scope=${this.key}`;
		return row ? MetricObservationSchema.parse(json(row.observation)) : null;
	}
	async lastGood(metricId: string, definitionHash: string) {
		const [row] = await this
			.sql`SELECT observation FROM metric_observations WHERE scope=${this.key} AND metric_id=${metricId} AND definition_hash=${definitionHash} AND status='ok' ORDER BY evaluation_at DESC,id DESC LIMIT 1`;
		return row ? MetricObservationSchema.parse(json(row.observation)) : null;
	}
	/** Backward-only: ok, window.end in [at - maxAge, at], observedAt <= at + maxAge. */
	async at(
		metricId: string,
		definitionHash: string,
		evaluationAt: string,
		maxAgeSeconds: number,
	) {
		const [row] = await this
			.sql`SELECT observation FROM metric_observations WHERE scope=${this.key} AND metric_id=${metricId} AND definition_hash=${definitionHash}
      AND status='ok' AND observation->'value' IS NOT NULL AND jsonb_typeof(observation->'value')='number'
      AND evaluation_at <= ${evaluationAt}::timestamptz AND evaluation_at >= ${evaluationAt}::timestamptz - (${maxAgeSeconds} * interval '1 second')
      AND (observation->>'observedAt')::timestamptz <= ${evaluationAt}::timestamptz + (${maxAgeSeconds} * interval '1 second')
      ORDER BY evaluation_at DESC,(observation->>'observedAt')::timestamptz DESC,id DESC LIMIT 1`;
		return row ? MetricObservationSchema.parse(json(row.observation)) : null;
	}
	/**
	 * Server-side bucketing: date_bin over evaluation_at (window.end), DISTINCT ON
	 * the bucket preferring the last ok reading, generate_series for empty buckets.
	 */
	async buckets(
		metricId: string,
		definitionHash: string,
		range: MetricHistoryInput,
	) {
		const r = metricHistoryRange(range, new Date(Date.parse(range.to)));
		const origin = new Date(HISTORY_ORIGIN_MS[r.step]).toISOString();
		const step = `${r.stepMs / 1000} seconds`;
		const rows = await this.sql`WITH picked AS (
        SELECT DISTINCT ON (bucket) bucket, status, id, observation->'value' AS value FROM (
          SELECT date_bin(${step}::interval, evaluation_at, ${origin}::timestamptz) AS bucket, status, id, evaluation_at, observation
          FROM metric_observations
          WHERE scope=${this.key} AND metric_id=${metricId} AND definition_hash=${definitionHash}
            AND evaluation_at >= ${r.from}::timestamptz AND evaluation_at < ${r.to}::timestamptz
            AND status IN ('ok','error','unavailable')
        ) attempts
        ORDER BY bucket, (status='ok' AND jsonb_typeof(observation->'value')='number') DESC, evaluation_at DESC, id DESC
      )
      SELECT (extract(epoch FROM g) * 1000)::bigint AS start_ms, picked.status, picked.id, picked.value
      FROM generate_series(${r.from}::timestamptz, ${r.to}::timestamptz - ${step}::interval, ${step}::interval) AS g
      LEFT JOIN picked ON picked.bucket = g
      ORDER BY g`;
		return rows.map((row) => {
			const start = Number(row.start_ms);
			const status = row.status ? String(row.status) : "missing";
			const raw = json(row.value);
			const value =
				status === "ok" && typeof raw === "number" && Number.isFinite(raw)
					? raw
					: null;
			return {
				start: new Date(start).toISOString(),
				end: new Date(start + r.stepMs).toISOString(),
				status: (status === "ok" && value === null ? "missing" : status) as
					| "ok"
					| "error"
					| "unavailable"
					| "missing",
				value,
				observationId: row.id ? String(row.id) : null,
			};
		});
	}
	/**
	 * Main's head as recorded by the newest stored ok reading of `calculatorId`
	 * in this scope (any metric), from its `dolt:head:<hash>@<iso>` evidence,
	 * with the recorded time in [at - maxGapSeconds, at]. evaluation_at bounds
	 * the scan to that range; a reading computed long after its evaluation time
	 * is not a candidate. Null when none.
	 */
	async recordedMainHead(
		calculatorId: string,
		at: string,
		maxGapSeconds: number,
		signal?: AbortSignal,
	): Promise<{ hash: string; at: string } | null> {
		signal?.throwIfAborted();
		const query = this
			.sql`SELECT h.hash, to_char(h.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM (
        SELECT substring(e.ref FROM 11 FOR 32) AS hash,
          CASE WHEN e.ref ~ ${HEAD_REF} THEN substring(e.ref FROM 44)::timestamptz END AS at
        FROM metric_observations o CROSS JOIN LATERAL jsonb_array_elements_text(o.observation->'evidenceRefs') AS e(ref)
        WHERE o.scope=${this.key} AND o.status='ok' AND o.observation->>'calculatorVersion'=${calculatorId}
          AND jsonb_typeof(o.observation->'evidenceRefs')='array'
          AND o.evaluation_at <= ${at}::timestamptz AND o.evaluation_at >= ${at}::timestamptz - (${maxGapSeconds} * interval '1 second')
          AND e.ref LIKE 'dolt:head:%'
      ) h
      WHERE h.at <= ${at}::timestamptz AND h.at >= ${at}::timestamptz - (${maxGapSeconds} * interval '1 second')
      ORDER BY h.at DESC LIMIT 1`;
		const abort = () => {
			void query.cancel();
		};
		signal?.addEventListener("abort", abort, { once: true });
		let rows: Row[];
		try {
			rows = (await query) as unknown as Row[];
		} finally {
			signal?.removeEventListener("abort", abort);
		}
		signal?.throwIfAborted();
		const row = rows[0];
		const ms = Date.parse(String(row?.at ?? ""));
		return row && Number.isFinite(ms)
			? { hash: String(row.hash), at: new Date(ms).toISOString() }
			: null;
	}
	async snapshot(id: string) {
		const [row] = await this
			.sql`SELECT snapshot,observation FROM metric_observations WHERE id=${id} AND scope=${this.key}`;
		return row
			? ({
					definition: json(row.snapshot),
					observation: MetricObservationSchema.parse(json(row.observation)),
				} as MetricSnapshot)
			: null;
	}
	async scheduledAttempts(
		metricId: string,
		definitionHash: string,
		slot: string,
	) {
		const rows = await this
			.sql`SELECT observation FROM metric_observations WHERE scope=${this.key} AND metric_id=${metricId} AND definition_hash=${definitionHash} AND scheduled_for=${slot} ORDER BY evaluation_at DESC,id DESC LIMIT 4`;
		return rows.map((row) =>
			MetricObservationSchema.parse(json(row.observation)),
		);
	}
	async expireLeases() {
		await this
			.sql`UPDATE metric_observations SET status='error',lease_token=NULL,lease_expires_at=NULL,
      observation=observation || jsonb_build_object('status','error','reason','lease_expired','observedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      WHERE scope=${this.key} AND status='pending' AND lease_expires_at<clock_timestamp()
      AND id IN (SELECT id FROM metric_observations WHERE scope=${this.key} AND status='pending' AND lease_expires_at<clock_timestamp() ORDER BY lease_expires_at LIMIT 20 FOR UPDATE SKIP LOCKED)`;
	}
	async cursor() {
		const [row] = await this
			.sql`SELECT last_metric_id FROM metric_refresh_cursors WHERE scope=${this.key}`;
		return row?.last_metric_id ? String(row.last_metric_id) : null;
	}
	async advanceCursor(id: string) {
		await this
			.sql`INSERT INTO metric_refresh_cursors (scope,last_metric_id) VALUES (${this.key},${id}) ON CONFLICT (scope) DO UPDATE SET last_metric_id=EXCLUDED.last_metric_id`;
	}
}
