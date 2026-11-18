#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@scripts/validate/work-ladder-walk`
 * Purpose: The candidate integration check for the work status ladder (story.0047, task.0122, task.0139): walks one synthetic
 *   code item up the whole ladder against a running node and proves, step by step, that every status step is refused without
 *   its exit artifact (409 `gate_unmet` with the named `missing`) and taken with it, that a back move is free, and that a
 *   stale artifact does not carry a move.
 * Scope: HTTP against `--target`, as the bearer key in the environment. Writes only items labelled `synthetic`, one synthetic
 *   design inbox contribution and artifacts on those items. Does not touch any other item.
 * Invariants:
 *   - NO_SECRETS_ON_ARGV: the key is read from the environment (`COGNI_NODE_API_KEY`, or the variable `--key-env` names), never
 *     from an argument, never printed.
 *   - SYNTHETIC_ONLY: every item carries the `synthetic` label; every item still live at the end (or after a failure) is
 *     cancelled. An item that reached `done` is terminal and stays, labelled synthetic.
 *   - PR_DELIVERABLE_IS_REAL: the code deliverable is a merged pull request of `--repo` (found through the public GitHub API, or
 *     `--pr`), so the merge step is proven against a real merged head. The PR is only read.
 *   - ONE_LINE_PER_STEP: `PASS|FAIL <step> expect <status> [missing=<x>] got <status> [missing=<x>]`; exit 1 on any FAIL.
 * Side-effects: IO (HTTP writes to the target; GitHub public read; stdout; exit code).
 * Usage: COGNI_NODE_API_KEY=... pnpm validate:work-ladder --target https://<node-origin> [--repo owner/repo] [--pr <number>]
 *   [--goal <goal-label-id>] [--key-env NAME]
 * Links: hub work-status-ladder, work-gate-enforcement, node-observability-finish-pass; read the Loki window printed at the end
 *   through the operator log proxy (node-service-logs-read) and expect one terminal event per step.
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		target: { type: "string" },
		repo: { type: "string", default: "cogni-dao/node-template" },
		pr: { type: "string" },
		goal: { type: "string", default: "goal-ai-work-converges" },
		"key-env": { type: "string", default: "COGNI_NODE_API_KEY" },
	},
});

function usage(message) {
	console.error(`usage error: ${message}`);
	process.exit(2);
}

const target = values.target?.replace(/\/+$/, "");
const key = process.env[values["key-env"]];
if (!target || !/^https?:\/\//.test(target)) usage("--target <origin> is required");
if (!key) usage(`${values["key-env"]} is not set in the environment`);

const api = `${target}/api/v1`;
const stamp = Date.now();
const SCORES = Object.fromEntries(
	["goal", "time", "unblocks", "ease", "confidence", "agent"].map((axis) => [axis, { v: 3 }]),
);
const labels = ["synthetic", `goal:${values.goal}`];
const PASS_ROWS = [
	{ tweak: "SYNTHETIC WALK", human: "—", ai: "🟢", loki: "🟢", trace: "—", overall: "🟢 PASS" },
];

let failures = 0;
const live = new Set(); // synthetic item ids not yet known terminal

async function call(method, path, body) {
	const res = await fetch(`${api}${path}`, {
		method,
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(60_000),
	});
	const json = await res.json().catch(() => ({}));
	return { status: res.status, json };
}

class Abort extends Error {}

const show = (status, missing) => `${status}${missing ? ` missing=${missing}` : ""}`;

/** One step: run the call, compare status (and `missing`), print one line. `must`: a mismatch ends the walk of this item. */
async function step(name, method, path, body, expect, { must = false } = {}) {
	const { status, json } = await call(method, path, body);
	const missing = typeof json.missing === "string" ? json.missing : undefined;
	const ok = status === expect.status && missing === expect.missing;
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} expect ${show(expect.status, expect.missing)}  got ${show(status, missing)}${
			ok || !json.errorCode ? "" : `  errorCode=${json.errorCode}`
		}`,
	);
	if (!ok) {
		failures += 1;
		if (must) throw new Abort(name);
	}
	return { ok, json };
}

const patch = (name, id, to, expect, opts) =>
	step(name, "PATCH", `/work/items/${id}`, { reason: "ladder walk", set: { status: to } }, expect, opts);
const artifact = (name, id, body) =>
	step(name, "POST", `/work/items/${id}/artifacts`, body, { status: 201 }, { must: true });
const OK = { status: 200 };
const MUST = { must: true };
const unmet = (missing) => ({ status: 409, missing });

async function create(name, summary) {
	const { ok, json } = await step(
		`create ${name} item`,
		"POST",
		"/work/items",
		{ type: "task", title: `synthetic ladder walk ${name} ${stamp}`, labels, scores: SCORES, summary },
		{ status: 201 },
		MUST,
	);
	if (ok) live.add(json.id);
	return json.id;
}

/** A merged pull request of `--repo`, read from the public GitHub API: its url and head sha. */
async function mergedPr() {
	const headers = {
		accept: "application/vnd.github+json",
		"user-agent": "cogni-ladder-walk",
		...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
	};
	const read = async (path) => {
		const res = await fetch(`https://api.github.com/repos/${values.repo}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
		if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
		return res.json();
	};
	const pr = values.pr
		? await read(`/pulls/${values.pr}`)
		: (await read("/pulls?state=closed&sort=updated&direction=desc&per_page=30")).find((p) => p.merged_at);
	if (!pr?.merged_at) throw new Error(`no merged pull request found in ${values.repo}`);
	return { url: pr.html_url, head: pr.head.sha.toLowerCase() };
}

async function walkCode(pr) {
	const X = await create("code", "Synthetic ladder walk: the whole ladder.");
	console.log(`item ${X}  pr ${pr.url}@${pr.head.slice(0, 7)}`);
	await patch("jump triage -> implementation_review", X, "needs_implementation_review", unmet("path"));
	await patch("triage -> design without a triage artifact", X, "needs_design", unmet("triage"));
	await artifact("triage artifact (design)", X, { kind: "triage", subject: `work:${X}`, verdict: "design", note: "ladder walk" });
	await patch("triage -> needs_design", X, "needs_design", OK, MUST);

	// An agent cannot close an inbox and each principal may hold 10 open, so a walk reuses an open synthetic design inbox.
	const open = await call("GET", "/knowledge/contributions?state=open&limit=50");
	const reused = (open.json?.contributions ?? open.json?.items ?? []).find(
		(c) => c.message === "synthetic ladder walk design" && c.headCommit,
	);
	const inbox = reused ? { status: 200, json: reused } : await call("POST", "/knowledge/contributions", {
		message: "synthetic ladder walk design",
		idempotencyKey: `ladder-walk-${stamp}`,
		edits: [
			{
				op: "insert",
				entry: {
					id: `synthetic-ladder-walk-${stamp}`,
					domain: "meta",
					entryType: "finding",
					title: "Synthetic ladder walk design",
					content: "Synthetic design for the work-ladder walk; never merge.",
					useWhen: "never; synthetic walk fixture",
					tags: ["synthetic"],
				},
			},
		],
	});
	const contribution = inbox.json.contributionId ?? inbox.json.id;
	const head = inbox.json.headCommit;
	const inboxOk = inbox.status >= 200 && inbox.status < 300 && contribution && head;
	console.log(`${inboxOk ? "PASS" : "FAIL"}  ${"synthetic design inbox".padEnd(46)} expect 2xx  got ${inbox.status}  ${contribution ?? ""}`);
	if (!inboxOk) {
		failures += 1;
		throw new Abort("inbox");
	}
	const review = { kind: "design_review", subject: `knowledge:${contribution}@${head}`, verdict: "approve", body: "ladder walk review" };

	await patch("needs_design -> needs_design_review", X, "needs_design_review", OK, MUST);
	await patch("design_review -> implement without an approve", X, "needs_implement", unmet("design_review"));
	await artifact("design_review artifact (approve)", X, review);
	await patch("design_review -> needs_implement", X, "needs_implement", OK, MUST);

	// A design-route item may move back to a design stage, and the approve it held no longer stands (task.0122).
	await patch("back needs_implement -> needs_design", X, "needs_design", OK, MUST);
	await patch("needs_design -> needs_design_review", X, "needs_design_review", OK, MUST);
	await patch("stale approve does not carry the move", X, "needs_implement", unmet("design_review"));
	await artifact("design_review artifact (approve again)", X, review);
	await patch("design_review -> needs_implement (again)", X, "needs_implement", OK, MUST);

	await patch("implement -> review without a pr", X, "needs_implementation_review", unmet("pr"));
	await step("set pr (a merged pull request)", "PATCH", `/work/items/${X}`, { reason: "ladder walk", set: { pr: pr.url } }, OK, MUST);
	await patch("needs_implement -> needs_implementation_review", X, "needs_implementation_review", OK, MUST);
	await patch("review -> validation without a review", X, "needs_validation", unmet("implementation_review"));
	await artifact("implementation_review artifact (approve)", X, { kind: "implementation_review", subject: `${pr.url}@${pr.head}`, verdict: "approve", body: "ladder walk review" });
	await patch("needs_implementation_review -> needs_validation", X, "needs_validation", OK, MUST);
	await patch("validation -> merge without a validation", X, "needs_merge", unmet("validation"));
	await artifact("validation artifact (pass)", X, { kind: "validation", subject: `${pr.url}@${pr.head}`, verdict: "pass", url: pr.url, rows: PASS_ROWS });
	await patch("needs_validation -> needs_merge", X, "needs_merge", OK, MUST);
	await patch("needs_merge -> needs_closeout (the pr is merged)", X, "needs_closeout", OK, MUST);
	await patch("closeout -> done without a closeout artifact", X, "done", unmet("closeout"));
	await artifact("closeout artifact (done)", X, { kind: "closeout", subject: `work:${X}`, verdict: "done", note: "ladder walk: synthetic, no KPI reading", body: "ladder walk closeout" });
	await patch("needs_closeout -> done", X, "done", OK, MUST);
	live.delete(X); // terminal: it stays, labelled synthetic
	await patch("done is terminal", X, "needs_triage", unmet("terminal"));
}

async function walkBack() {
	const Y = await create("back-move", "Synthetic ladder walk: back is free, a stale triage is not enough.");
	console.log(`item ${Y}`);
	await artifact("triage artifact (implement)", Y, { kind: "triage", subject: `work:${Y}`, verdict: "implement", note: "ladder walk" });
	await patch("triage -> needs_implement", Y, "needs_implement", OK, MUST);
	await patch("back needs_implement -> needs_triage", Y, "needs_triage", OK, MUST);
	await patch("triage -> implement on the stale triage", Y, "needs_implement", unmet("triage"));
}

/** Every synthetic item still live is cancelled, whatever happened above. */
async function cleanup() {
	for (const id of live) {
		const { status } = await call("PATCH", `/work/items/${id}`, { reason: "ladder walk cleanup", set: { status: "cancelled" } });
		console.log(`${status === 200 ? "PASS" : "FAIL"}  ${`cancel ${id}`.padEnd(46)} expect 200  got ${status}`);
		if (status !== 200) failures += 1;
	}
}

const startedAt = new Date();
let version = "unknown";
try {
	version = (await (await fetch(`${target}/version`, { signal: AbortSignal.timeout(15_000) })).json()).buildSha ?? "unknown";
} catch {
	// the walk itself will say what is wrong
}
console.log(`target ${target}  buildSha ${version}  start ${startedAt.toISOString()}`);

try {
	const pr = await mergedPr();
	await step("create with status needs_implement is refused", "POST", "/work/items", { type: "task", title: `synthetic ladder walk refusal ${stamp}`, status: "needs_implement", labels }, { status: 400 });
	await walkCode(pr);
	await walkBack();
} catch (error) {
	if (!(error instanceof Abort)) {
		failures += 1;
		console.log(`FAIL  walk stopped: ${error instanceof Error ? error.message : String(error)}`);
	}
} finally {
	await cleanup().catch(() => {
		failures += 1;
		console.log("FAIL  cleanup did not finish; cancel the synthetic items by hand");
	});
}

const endedAt = new Date();
console.log(
	`loki window ${startedAt.toISOString()} .. ${new Date(endedAt.getTime() + 120_000).toISOString()} (end + 2 min for log shipping); ` +
		"expect one work.items.{create,patch}_{success,refused} or artifact_{recorded,refused} line per step",
);
console.log(failures ? `FAILED: ${failures} step(s)` : "ALL STEPS PASSED");
process.exit(failures ? 1 : 0);
