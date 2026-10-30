// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Scoped injected SQL. Snapshot reservation precedes I/O; completed observations never change. */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import {
	MetricError,
	MetricObservationSchema,
	type MetricObservationsPort,
	type MetricScope,
	type MetricSnapshot,
} from "../contracts.js";

type Row = Record<string, unknown>;
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
	async at(metricId: string, definitionHash: string, evaluationAt: string) {
		const [row] = await this
			.sql`SELECT observation FROM metric_observations WHERE scope=${this.key} AND metric_id=${metricId} AND definition_hash=${definitionHash} AND evaluation_at<=${evaluationAt} ORDER BY evaluation_at DESC,id DESC LIMIT 1`;
		return row ? MetricObservationSchema.parse(json(row.observation)) : null;
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
      WHERE id IN (SELECT id FROM metric_observations WHERE scope=${this.key} AND status='pending' AND lease_expires_at<clock_timestamp() ORDER BY lease_expires_at LIMIT 20)`;
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
