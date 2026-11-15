// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@scripts/db/place-legacy-work-items`
 * Purpose: The one-shot cutover to the status ladder (task.0122, hub work-status-ladder "Cutover"): moves every work item
 *   still in needs_closeout or blocked to the stage its facts name.
 * Scope: Run ONCE per node, by the operator, against that node's Doltgres through its custody, AFTER migration 0008 and the app
 *   version that has `status_revision` are deployed; never by deploy. Migration 0008 already moved every needs_merge item to
 *   needs_closeout, so needs_merge is never a source.
 *   Usage: DOLTGRES_URL=... node scripts/db/place-legacy-work-items.mjs [--apply]
 *   Without `--apply` it prints the plan and writes nothing.
 * Invariants:
 *   - THE_STORE_DECIDES: the script only reads item ids and asks `DoltgresWorkItemAdapter.planPlacement`, then asks `place` to apply
 *     that plan. The adapter reads the PR (through the PR-facts port) or inbox state itself, and `place` refuses any `to` that is
 *     not its own plan: merged -> done, open -> needs_implementation_review, no `pr` -> needs_implement (a spike: needs_research),
 *     blocked -> needs_triage. A PR or inbox that cannot be read places nothing and is reported.
 *   - SYSTEM_WRITER_PATH: each move is the same writer lock, operation branch and commit proof as any patch, attributed to
 *     `system:work-items-placement`, with one fixed reason. There is no exit-artifact gate for `place`, and it refuses any
 *     item outside needs_closeout and blocked; the move predicate itself has no legacy case.
 *   - IDEMPOTENT: only items still in needs_closeout or blocked are selected, and a placed item is no longer one, so a second run
 *     places nothing. An item skipped because its state was unreadable stays selected for a later run.
 *   - NO_CREDENTIALS: PR state is read from GitHub unauthenticated (about 60 reads an hour); an inbox's state is read from this
 *     node's own `knowledge_contributions`.
 * Side-effects: IO (Doltgres writes with --apply, GitHub public reads)
 * Links: hub work-status-ladder, work-gate-enforcement
 */

// biome-ignore-all lint/suspicious/noConsole: one-shot operator script; stdout is its report
// biome-ignore-all lint/style/noProcessEnv: one-shot operator script reads DOLTGRES_URL directly

import { parseArgs } from "node:util";
import postgres from "postgres";
import { createDoltgresWorkItemStore } from "../../packages/work-items/dist/adapters/doltgres/index.js";

const PRINCIPAL = "system:work-items-placement";

const { values } = parseArgs({ options: { apply: { type: "boolean" } } });
const url = process.env.DOLTGRES_URL?.trim();
if (!url) throw new Error("DOLTGRES_URL is required");

const reader = postgres(url, { max: 1 });
const makeClient = () => postgres(url, { max: 1 });

/** The adapter's PR-facts port: GitHub, unauthenticated. */
const prFacts = {
	async read(prUrl, signal) {
		const match =
			/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([0-9]+)$/.exec(
				prUrl,
			);
		if (!match) throw new Error("not a GitHub pull request URL");
		const res = await fetch(
			`https://api.github.com/repos/${match[1]}/${match[2]}/pulls/${match[3]}`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "cogni-node-placement",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal,
			},
		);
		if (!res.ok) throw new Error(`GitHub ${res.status}`);
		const body = await res.json();
		return {
			head: String(body.head?.sha ?? "").toLowerCase(),
			merged: body.merged === true || Boolean(body.merged_at),
			open: body.state === "open",
		};
	},
};

/** The adapter's inbox port: this node's own knowledge_contributions. */
const inboxes = {
	async stateOf(contributionId) {
		const rows = await reader.unsafe(
			`SELECT state, head_commit FROM knowledge_contributions WHERE id = '${contributionId.replace(/'/g, "''")}' LIMIT 1`,
		);
		const row = rows[0];
		return row
			? {
					head: row.head_commit ?? null,
					merged: row.state === "merged",
					open: row.state === "open",
				}
			: null;
	},
};

const adapter = createDoltgresWorkItemStore(makeClient(), {
	writerLockProtocol: "database",
	recreateClient: makeClient,
	readClient: reader,
	recreateReadClient: makeClient,
	entryResolver: null,
	metricBaseline: null,
	prFacts,
	inboxes,
});

const items = await reader.unsafe(
	"SELECT id, status FROM work_items WHERE status IN ('needs_closeout', 'blocked') ORDER BY id",
);
console.log(
	`${items.length} item(s) in needs_closeout or blocked; mode: ${values.apply ? "APPLY" : "dry run (pass --apply to write)"}`,
);

const summary = { placed: 0, planned: 0, skipped: 0, failed: 0 };
for (const item of items) {
	const line = { id: item.id, from: item.status };
	try {
		const plan = await adapter.planPlacement(item.id);
		if (!plan) {
			summary.skipped += 1;
			console.log(JSON.stringify({ ...line, result: "skipped: no readable placement" }));
			continue;
		}
		if (!values.apply) {
			summary.planned += 1;
			console.log(JSON.stringify({ ...line, pr: plan.pr || null, to: plan.to, result: "planned" }));
			continue;
		}
		await adapter.place({ id: item.id, to: plan.to }, PRINCIPAL);
		summary.placed += 1;
		console.log(JSON.stringify({ ...line, pr: plan.pr || null, to: plan.to, result: "placed" }));
	} catch (error) {
		summary.failed += 1;
		console.log(
			JSON.stringify({
				...line,
				result: `failed: ${error instanceof Error ? error.name : "error"}`,
			}),
		);
	}
}
console.log(JSON.stringify({ summary }));
await reader.end({ timeout: 5 });
process.exit(summary.failed ? 1 : 0);
