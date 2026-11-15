// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Real Doltgres proof for knowledge.merge-review@1: the one statement parses and
 * counts merges in the half-open window, split by resolver, with a clean empty case. */
import postgres, { type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readKnowledgeMerges } from "../../../../packages/metrics/src/sources";

let container: StartedTestContainer | undefined;
let knowledge: Sql;
const signal = () => new AbortController().signal;
const window = {
	start: "2026-11-07T00:00:00.000Z",
	end: "2026-11-14T00:00:00.000Z",
};

beforeAll(async () => {
	container = await new GenericContainer("dolthub/doltgresql:0.57.3")
		.withEnvironment({ DOLTGRES_PASSWORD: "native-test" })
		.withExposedPorts(5432)
		.withWaitStrategy(Wait.forLogMessage(/server (started|listening)/i, 1))
		.start();
	knowledge = postgres(
		`postgresql://postgres:native-test@${container.getHost()}:${container.getMappedPort(5432)}/postgres`,
		{ max: 1, fetch_types: false },
	);
	// Same columns as doltgres-migrations/0000_init.sql.
	await knowledge.unsafe(
		`CREATE TABLE knowledge_contributions (
			id text PRIMARY KEY NOT NULL,
			branch text NOT NULL,
			state text NOT NULL,
			principal_id text NOT NULL,
			principal_kind text NOT NULL,
			message text NOT NULL,
			base_commit text NOT NULL,
			head_commit text,
			commit_count integer DEFAULT 0 NOT NULL,
			merged_commit text,
			closed_reason text,
			idempotency_key text,
			confidence_pct integer DEFAULT 40 NOT NULL,
			created_at timestamp with time zone DEFAULT now() NOT NULL,
			resolved_at timestamp with time zone,
			resolved_by text
		)`,
	);
	const rows: Array<[string, string, string, string | null, string | null]> = [
		// [id, state, principal, resolved_by, resolved_at]
		["c-self-at-start", "merged", "alice", "alice", "2026-11-07T00:00:00Z"],
		["c-reviewed", "merged", "alice", "bob", "2026-11-10T12:00:00Z"],
		["c-open", "open", "alice", null, null],
		["c-before-window", "merged", "alice", "bob", "2026-11-06T23:59:59Z"],
		["c-at-window-end", "merged", "alice", "bob", "2026-11-14T00:00:00Z"],
	];
	for (const [id, state, principal, by, at] of rows)
		await knowledge.unsafe(
			`INSERT INTO knowledge_contributions (id, branch, state, principal_id, principal_kind, message, base_commit, resolved_at, resolved_by) VALUES ('${id}', 'b-${id}', '${state}', '${principal}', 'agent', 'm', 'base', ${at ? `'${at}'` : "NULL"}, ${by ? `'${by}'` : "NULL"})`,
		);
}, 120000);
afterAll(async () => {
	if (knowledge) await knowledge.end({ timeout: 3 });
	if (container) await container.stop();
});

it("counts in-window merges and the share another principal resolved", async () => {
	const merged = await readKnowledgeMerges(
		knowledge,
		"merged",
		window,
		signal(),
	);
	expect(merged).toMatchObject({ value: 2, unit: "items", complete: true });
	expect(merged.evidenceRefs).toContain(
		"counts:merged=2;reviewed=1;unresolved=0",
	);
	const share = await readKnowledgeMerges(knowledge, "share", window, signal());
	expect(share).toMatchObject({ value: 0.5, unit: "ratio", complete: true });
});

it("an empty window is a zero denominator, and its raw count is a real 0", async () => {
	const empty = {
		start: "2026-10-01T00:00:00.000Z",
		end: "2026-10-02T00:00:00.000Z",
	};
	expect(
		await readKnowledgeMerges(knowledge, "share", empty, signal()),
	).toMatchObject({ complete: false, reason: "zero_denominator" });
	expect(
		await readKnowledgeMerges(knowledge, "merged", empty, signal()),
	).toMatchObject({ value: 0, complete: true });
});

it("a merge with no resolver makes the share unknown", async () => {
	await knowledge.unsafe(
		"INSERT INTO knowledge_contributions (id, branch, state, principal_id, principal_kind, message, base_commit, resolved_at) VALUES ('c-no-resolver', 'b-nr', 'merged', 'alice', 'agent', 'm', 'base', '2026-11-12T00:00:00Z')",
	);
	expect(
		await readKnowledgeMerges(knowledge, "share", window, signal()),
	).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
	expect(
		await readKnowledgeMerges(knowledge, "merged", window, signal()),
	).toMatchObject({ value: 3, complete: true });
});
