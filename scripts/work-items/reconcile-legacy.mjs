#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@scripts/work-items/reconcile-legacy`
 * Purpose: Walks legacy work items (re-triaged to needs_triage at the ladder cutover, story.0047) forward through the gated
 *   work API, using only facts already on the item. Hub procedure: `work-legacy-reconcile`; the per-item plan is the ledger
 *   atom `work-cutover-ledger`.
 * Scope: HTTP against `--target`, as the bearer key in the environment. It reads items and their artifacts, and with `--apply`
 *   writes only the moves below (plus the `pr` patches named by `--set-pr`). One target per run: a node or the operator.
 * Invariants:
 *   - NO_SECRETS_ON_ARGV: the key is read from the environment (`COGNI_NODE_API_KEY`, or the variable `--key-env` names), never
 *     from an argument, never printed. The script needs no database credential.
 *   - DRY_RUN_BY_DEFAULT: without `--apply` nothing is written; every item prints one plan row.
 *   - LEGACY_BACK_TO_TRIAGE: an item still in needs_closeout or blocked first moves to needs_triage (the only move a legacy status
 *     allows); a blocked item stops there. `--legacy` lists every such item on the target.
 *   - NO_AI: it calls no model and spends no AI budget; owners advance items past implementation review with real artifacts.
 *   - FACTS_ONLY: needs_triage -> needs_implement happens only when the item already has six nonzero scores and a `goal:` label;
 *     it records a `triage` artifact (route `implement`; `research` for a spike whose `pr` is a hub inbox) first. needs_implement
 *     -> needs_implementation_review happens only for a non-story whose `pr` names a deliverable. A missing goal label is never
 *     invented: the item stays and is listed.
 *   - LEDGER_TARGET_HOLDS: with `--from-ledger`, an item whose ledger target is needs_triage (it was blocked) is not advanced.
 *   - NEVER_FABRICATES_REVIEW: it never records an `implementation_review`, a `design_review` or a `validation`. Those need a real
 *     reviewer or validator, so the review queue it prints is the hand-off.
 *   - GATE_DECIDES: a refused move (409 `gate_unmet`) is printed with its verbatim `missing` and the item stays where it is.
 *   - CONCURRENCY_ONE: writes serialize on the node's writer lock anyway; a 503 `lock_contended` is retried with backoff.
 * Side-effects: IO (HTTP reads and, with --apply, writes to the target; stdout; exit code 1 when a write was refused).
 * Usage: COGNI_NODE_API_KEY=... node scripts/work-items/reconcile-legacy.mjs --target https://<node-origin>
 *   (--legacy | --ids task.0055,story.0044 | --from-ledger <file>) [--set-pr task.0055=<pr-url>,...] [--apply] [--key-env NAME]
 *   [--ledger-md]   (--ledger-md prints the plan as ledger-atom table rows, for the review before --apply)
 *   <file> is the ledger atom markdown (rows start `| [id](...)`), or JSON: an array of ids or `{ items: [{ id }] }`.
 * Links: hub work-legacy-reconcile, work-cutover-ledger, work-status-ladder, work-gate-enforcement
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		target: { type: "string" },
		ids: { type: "string" },
		"from-ledger": { type: "string" },
		"set-pr": { type: "string" },
		apply: { type: "boolean", default: false },
		legacy: { type: "boolean", default: false },
		"ledger-md": { type: "boolean", default: false },
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
if (!values.ids && !values["from-ledger"] && !values.legacy) usage("--legacy, --ids <a,b> or --from-ledger <file> is required");

const api = `${target}/api/v1`;
const SIX = ["goal", "time", "unblocks", "ease", "confidence", "agent"];
const LADDER = [
	"needs_triage",
	"needs_research",
	"needs_design",
	"needs_design_review",
	"needs_implement",
	"needs_implementation_review",
	"needs_validation",
	"needs_merge",
	"done",
];
const INBOX_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/knowledge\/inbox\/contrib-[a-z0-9-]{1,200}$/;
const ID = /^[a-z]+\.[0-9]+$/;
const LEGACY = ["needs_closeout", "blocked"];

/** Every item on the target still in a legacy status, paged with the list cursor. */
async function legacyIds() {
	const ids = [];
	let cursor;
	do {
		const query = `statuses=${LEGACY.join(",")}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
		const res = await call("GET", `/work/items?${query}`);
		if (res.status !== 200) usage(`listing legacy items failed: ${res.status} ${res.json.errorCode ?? ""}`);
		ids.push(...(res.json.items ?? []).map((item) => item.id));
		cursor = res.json.pageInfo?.hasMore ? res.json.pageInfo.endCursor : (res.json.nextCursor ?? undefined);
	} while (cursor);
	return ids;
}

/** Ids (and the ledger's target column, when there is one) from `--ids` or `--from-ledger`. */
function readIds() {
	const ledgerTargets = new Map();
	const ids = [];
	if (values.ids) ids.push(...values.ids.split(",").map((s) => s.trim()).filter(Boolean));
	if (values["from-ledger"]) {
		const text = readFileSync(values["from-ledger"], "utf8");
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {}
		if (parsed) {
			const list = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
			for (const entry of list) ids.push(typeof entry === "string" ? entry : entry.id);
		} else {
			for (const line of text.split("\n")) {
				const cells = line.split("|").map((c) => c.trim());
				const id = /^\[([a-z]+\.[0-9]+)\]\(/.exec(cells[1] ?? "")?.[1];
				if (!id) continue;
				ids.push(id);
				const stage = cells.find((c) => LADDER.includes(c));
				if (stage) ledgerTargets.set(id, stage);
			}
		}
	}
	for (const id of ids) if (!ID.test(id)) usage(`not a work item id: ${id}`);
	return { ids: [...new Set(ids)], ledgerTargets };
}

/** `--set-pr id=url,...` as a map. */
function readSetPr() {
	const map = new Map();
	for (const pair of (values["set-pr"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
		const [id, ...rest] = pair.split("=");
		const url = rest.join("=");
		if (!ID.test(id ?? "") || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[0-9]+$/.test(url)) usage(`--set-pr wants <id>=<github pull url>: ${pair}`);
		map.set(id, url);
	}
	return map;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One call; a 503 `lock_contended` (writes serialize on the writer lock) or a transient `artifacts_unavailable` is retried with backoff. */
async function call(method, path, body) {
	for (let attempt = 0; ; attempt += 1) {
		const res = await fetch(`${api}${path}`, {
			method,
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(60_000),
		});
		const json = await res.json().catch(() => ({}));
		if (res.status === 503 && /lock_contended|artifacts_unavailable/.test(JSON.stringify(json)) && attempt < 8) {
			await sleep(Math.min(500 * 2 ** attempt, 8_000) + Math.random() * 250);
			continue;
		}
		return { status: res.status, json };
	}
}

const words = (text) => text.trim().split(/\s+/).length;
const goalLabel = (item) => (item.labels ?? []).some((l) => l.startsWith("goal:"));
const sixFilled = (item) => SIX.every((axis) => (item.scores?.[axis]?.v ?? 0) > 0);
const isStory = (item) => item.type === "story";
const hasMoves = (item) => (item.moves?.length ?? 0) > 0;
const isInbox = (pr) => INBOX_URL.test(pr ?? "");
const hasDeliverable = (pr) => /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[0-9]+$/.test(pr ?? "") || isInbox(pr);
const route = (item) => (item.type === "spike" && isInbox(item.pr) ? "research" : "implement");

async function read(id) {
	const item = await call("GET", `/work/items/${id}`);
	if (item.status !== 200) return { id, error: `read ${item.status} ${item.json.errorCode ?? ""}`.trim() };
	const arts = await call("GET", `/work/items/${id}/artifacts`);
	const artifacts = arts.status === 200 ? (arts.json.items ?? arts.json.artifacts ?? []) : [];
	return { id, item: item.json, artifacts };
}

/** What `--apply` would do next for the item as read, and what is still missing after that. */
function plan(item, artifacts, setPr, ledgerTarget) {
	const status = item.status;
	const pr = setPr.get(item.id) ?? item.pr;
	const missing = [];
	let next = "none";
	if (LEGACY.includes(status)) {
		next = status === "blocked" ? "-> needs_triage, then stay: a blocker in blockedBy" : "-> needs_triage, then re-read";
		if (status === "blocked") missing.push("a blocker in blockedBy");
	} else if (status === "needs_triage" && ledgerTarget === "needs_triage") {
		next = "stay: the ledger target is needs_triage (a blocker in blockedBy, then a fresh triage)";
		missing.push("a blocker in blockedBy");
	} else if (status === "needs_triage") {
		if (item.type === "spike" && !isInbox(pr)) {
			next = "stay: spike has no hub-inbox deliverable (needs a human or agent triage)";
			missing.push("hub inbox in pr");
		} else {
			if (!sixFilled(item)) missing.push("six nonzero scores");
			if (!goalLabel(item)) missing.push("goal: label");
			if (missing.length) {
				next = `stay: needs a human or agent triage: ${missing.join(", ")}`;
			} else {
				const r = route(item);
				next = `triage artifact (${r}${hasMoves(item) ? "" : ", measurement gap note"}) -> ${r === "research" ? "needs_research" : "needs_implement"}`;
				if (r === "implement" && !isStory(item) && hasDeliverable(pr)) next += " -> needs_implementation_review";
			}
		}
	} else if (status === "needs_implement") {
		if (isStory(item)) next = "stay: story waits for its children";
		else if (hasDeliverable(pr)) next = "-> needs_implementation_review";
		else next = "stay: pr names no deliverable";
	} else if (status === "needs_research") {
		next = "stay: spike done only when its inbox is merged";
	} else {
		next = "stay: later stages need a real reviewer or validator";
	}
	if (isStory(item)) missing.push("children done or cancelled, then a live validation");
	else if (!hasDeliverable(pr)) missing.push("pr naming a deliverable");
	else {
		const review = artifacts.some((a) => a.kind === "implementation_review");
		if (status !== "needs_validation" && status !== "needs_merge" && status !== "done") missing.push(review ? "a fresh review at the head" : "a fresh review at the head (none on record)");
		missing.push("a PASS validation at the reviewed head", "merge");
	}
	return { next, missing: [...new Set(missing)], pr };
}

const refusals = [];

/** PATCH one item; a 409 is recorded verbatim and returns false. `retryOn`: a 409 `missing` that the caller repairs, not recorded. */
async function patch(item, set, reason, retryOn) {
	if (words(reason) > 25) throw new Error(`reason over 25 words: ${reason}`);
	const res = await call("PATCH", `/work/items/${item.id}`, { reason, cites: [{ id: "work-status-ladder" }], set });
	if (res.status === 200) return true;
	const missing = typeof res.json.missing === "string" ? res.json.missing : undefined;
	if (retryOn && res.status === 409 && missing === retryOn) return false;
	refusals.push({ id: item.id, to: set.status ?? "(pr)", status: res.status, errorCode: res.json.errorCode, missing });
	console.log(`  REFUSED ${item.id} -> ${set.status ?? "pr"}: ${res.status} ${res.json.errorCode ?? ""}${missing ? ` missing=${missing}` : ""}`);
	return false;
}

function triageNote(item) {
	const base = isStory(item) ? "Story: children carry the PRs; route implement." : `Re-triage of a legacy ${item.type}; route implement.`;
	const gap = hasMoves(item) ? "" : " Measurement gap: no moves recorded before cutover; none invented.";
	return `${base}${gap}`.slice(0, 240);
}

async function recordTriage(item, verdict) {
	const body = { kind: "triage", subject: `work:${item.id}`, verdict, note: triageNote(item) };
	const res = await call("POST", `/work/items/${item.id}/artifacts`, body);
	if (res.status !== 201) {
		refusals.push({ id: item.id, to: "triage artifact", status: res.status, errorCode: res.json.errorCode });
		console.log(`  REFUSED ${item.id} triage artifact: ${res.status} ${res.json.errorCode ?? ""} ${JSON.stringify(res.json.issues ?? res.json.message ?? "")}`);
		return false;
	}
	console.log(`  recorded triage (${verdict}) on ${item.id}`);
	return true;
}

/** Walk one item with the moves its facts justify. Returns nothing; the caller re-reads. */
async function walk(state, setPr, ledgerTarget) {
	let { item } = state;
	if (LEGACY.includes(item.status)) {
		const ok = await patch(item, { status: "needs_triage" }, "Legacy status retired by the artifact-gated ladder (story.0047); re-enters at triage to advance with real artifacts.");
		if (!ok || item.status === "blocked") return;
		const fresh = await read(item.id);
		if (fresh.error) return;
		({ item } = fresh);
		state = fresh;
	}
	const pr = setPr.get(item.id);
	if (pr && item.pr !== pr) {
		const ok = await patch(item, { pr }, `Set pr to ${pr.split("/").slice(-3).join("/")}: it delivers this item (checked).`);
		if (!ok) return;
		item = { ...item, pr };
	}
	if (item.status === "needs_triage") {
		if (ledgerTarget === "needs_triage") return;
		if (!sixFilled(item) || !goalLabel(item)) return;
		if (item.type === "spike" && !isInbox(item.pr)) return;
		const r = route(item);
		const stage = r === "research" ? "needs_research" : "needs_implement";
		const existing = state.artifacts.filter((a) => a.kind === "triage").sort((a, b) => b.seq - a.seq)[0];
		const reason = `Legacy item re-triaged: scores and goal label present, route ${r}; moving forward on its own artifact.`;
		// A fresh triage artifact of this route may already stand (a rerun); if the gate calls it stale, record a new one.
		let moved = existing?.verdict === r && (await patch(item, { status: stage }, reason, "triage"));
		if (!moved) {
			if (!(await recordTriage(item, r))) return;
			moved = await patch(item, { status: stage }, reason);
			if (!moved) return;
		}
		item = { ...item, status: stage };
		if (stage !== "needs_implement") return;
	}
	if (item.status === "needs_implement" && !isStory(item) && hasDeliverable(item.pr)) {
		await patch(item, { status: "needs_implementation_review" }, "pr names this item's deliverable; ready for a fresh-context implementation review.");
	}
}

const { ids: listed, ledgerTargets } = readIds();
const ids = values.legacy ? [...new Set([...listed, ...(await legacyIds())])] : listed;
const setPr = readSetPr();
console.log(`${values.apply ? "APPLY" : "DRY RUN"} ${target}  ${ids.length} items`);
console.log(["id", "status", "target", "next action", "missing evidence"].join("\t"));

const unreadable = [];
for (const id of ids) {
	const state = await read(id);
	if (state.error) {
		unreadable.push(`${id}: ${state.error}`);
		console.log(`${id}\t?\t-\t${state.error}\t-`);
		continue;
	}
	const { item, artifacts } = state;
	const p = plan(item, artifacts, setPr, ledgerTargets.get(id));
	const targetStage = ledgerTargets.get(id) ?? (isStory(item) ? "needs_implement" : "needs_implementation_review");
	const nextAction = `${p.pr && p.pr !== item.pr ? `set pr ${p.pr}; ` : ""}${p.next}`;
	if (values["ledger-md"])
		console.log(`| [${id}](${target}/work/items/${id}) | ${item.type} | ${item.status} r${item.revision} | ${p.pr || "-"} | ${nextAction} | ${p.missing.join("; ") || "-"} |`);
	else console.log([id, item.status, targetStage, nextAction, p.missing.join("; ") || "-"].join("\t"));
	if (values.apply) await walk(state, setPr, ledgerTargets.get(id));
}

// Final read: counts by resulting stage and the review queue.
const counts = {};
const queue = [];
const stayed = [];
for (const id of ids) {
	const state = await read(id);
	if (state.error) continue;
	const { item, artifacts } = state;
	counts[item.status] = (counts[item.status] ?? 0) + 1;
	if (item.status === "needs_implementation_review") {
		const hasReview = artifacts.some((a) => a.kind === "implementation_review");
		queue.push(`${id}\t${item.pr}${hasReview ? "\t(review artifact on record)" : ""}`);
	}
	if (item.status === "needs_triage") {
		const why = [];
		if (!sixFilled(item)) why.push("six nonzero scores");
		if (!goalLabel(item)) why.push("goal label");
		if (item.type === "spike" && !isInbox(item.pr)) why.push("hub-inbox deliverable");
		stayed.push(`${id}\tneeds a human or agent triage: ${why.join(", ") || "(none missing; run --apply)"}`);
	}
}
console.log(`\nSUMMARY ${values.apply ? "after apply" : "now (dry run)"}`);
for (const [stage, n] of Object.entries(counts).sort((a, b) => LADDER.indexOf(a[0]) - LADDER.indexOf(b[0]))) console.log(`  ${stage}\t${n}`);
console.log(`\nREVIEW QUEUE (${queue.length}): needs a real implementation_review at the PR head; this script never records one`);
for (const row of queue) console.log(`  ${row}`);
console.log(`\nSTAYED IN TRIAGE (${stayed.length})`);
for (const row of stayed) console.log(`  ${row}`);
if (refusals.length) {
	console.log(`\nREFUSALS (${refusals.length})`);
	for (const r of refusals) console.log(`  ${r.id} -> ${r.to}: ${r.status} ${r.errorCode ?? ""}${r.missing ? ` missing=${r.missing}` : ""}`);
}
if (unreadable.length) console.log(`\nUNREADABLE\n  ${unreadable.join("\n  ")}`);
process.exit(refusals.length || unreadable.length ? 1 : 0);
