// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** A sweep cannot replace evidence completed before expiry but committed after it. */
import { randomUUID } from "node:crypto";
import { PostgresMetricObservations } from "@cogni-dao/metrics/adapters/postgres";
import type { MetricSnapshot } from "@cogni-dao/metrics/contracts";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

const node = `expiry-${randomUUID()}`;
const scope = { node, environment: "component", dataScope: "test" };
let sql: Sql;
let sweeperSql: Sql;
beforeAll(() => {
	if (!process.env.DATABASE_SERVICE_URL)
		throw new Error("component PostgreSQL required");
	sql = postgres(process.env.DATABASE_SERVICE_URL, { max: 5 });
	sweeperSql = postgres(process.env.DATABASE_SERVICE_URL, {
		max: 1,
		connection: { application_name: node, statement_timeout: "5s" },
	});
});
afterAll(async () => {
	await sql`DELETE FROM execution_requests WHERE idempotency_key LIKE ${`metric/${node}/%`}`;
	await sql`DELETE FROM metric_observations WHERE scope=${`${node}/component/test`}`;
	await sweeperSql?.end({ timeout: 1 });
	await sql?.end({ timeout: 1 });
});

it("skips a locked completion and expires an independent overdue attempt", async () => {
	const adapter = new PostgresMetricObservations(sql, scope);
	const snapshot: MetricSnapshot = {
		definition: {
			id: "work",
			title: "Work",
			revision: "1",
			spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 60 },
		},
		observation: {
			id: randomUUID(),
			metricId: "work",
			definitionRevision: "1",
			definitionHash: "hash",
			calculatorVersion: "work.count@1",
			paramsHash: "params",
			...scope,
			window: { start: "2026-11-02T00:00:00Z", end: "2026-11-02T00:00:00Z" },
			status: "pending",
			observedAt: null,
			value: null,
			unit: "items",
			reason: null,
			sourceWatermarks: [],
			evidenceRefs: [],
		},
	};
	const reservation = await adapter.reserve({
		snapshot,
		requestKey: "completion",
		requestHash: "a",
		leaseMs: 30000,
	});
	expect(reservation.leaseToken).not.toBeNull();
	const overdue = structuredClone(snapshot);
	overdue.observation.id = randomUUID();
	overdue.observation.window.end = "2026-11-02T00:01:00Z";
	await adapter.reserve({
		snapshot: overdue,
		requestKey: "overdue",
		requestHash: "b",
		leaseMs: 30000,
	});
	await sql`UPDATE metric_observations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${overdue.observation.id}`;
	const [deadline] =
		await sql`UPDATE metric_observations SET lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE id=${snapshot.observation.id} RETURNING lease_expires_at`;
	const result = {
		...snapshot.observation,
		status: "ok" as const,
		value: 5,
		observedAt: "2026-11-02T00:00:00Z",
		evidenceRefs: ["node:work"],
	};
	let unlock = () => {};
	const gate = new Promise<void>((resolve) => {
		unlock = resolve;
	});
	let ready = () => {};
	const completed = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const hold = Promise.resolve(
		sql.begin(async (tx) => {
			const owner = new PostgresMetricObservations(tx as unknown as Sql, scope);
			expect(
				await owner.complete(
					snapshot.observation.id,
					reservation.leaseToken as string,
					result,
				),
			).toEqual(result);
			ready();
			await gate;
		}),
	);
	// Surface transaction failure rather than hanging on the ready signal.
	await Promise.race([
		completed,
		hold.then(() => {
			throw new Error("completion did not hold lock");
		}),
	]);
	let sweep: Promise<void> | undefined;
	try {
		await sql`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (${deadline?.lease_expires_at}::timestamptz-clock_timestamp())))+0.05)`;
		let settled = false;
		sweep = new PostgresMetricObservations(sweeperSql, scope)
			.expireLeases()
			.then(() => {
				settled = true;
			});
		// Either SKIP LOCKED finishes, or the regressed query demonstrably waits
		// on this transaction. Release only after one of those facts is observed.
		let observed = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			const [activity] =
				await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${node} AND wait_event_type='Lock') AS waiting`;
			if (settled || activity?.waiting) {
				observed = true;
				break;
			}
			await sql`SELECT pg_sleep(0.01)`;
		}
		expect(observed).toBe(true);
	} finally {
		unlock();
		await hold;
		await sweep;
	}
	expect(await adapter.get(snapshot.observation.id)).toEqual(result);
	expect(await adapter.get(overdue.observation.id)).toMatchObject({
		status: "error",
		reason: "lease_expired",
	});
	await adapter.expireLeases();
	expect(await adapter.get(snapshot.observation.id)).toEqual(result);
}, 10000);
