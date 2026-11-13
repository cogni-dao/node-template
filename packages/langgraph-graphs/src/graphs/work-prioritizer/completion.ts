// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { isDeepStrictEqual } from "node:util";
/** Completion facts and bounded verification from the program's actual tool receipts. */
import type { ToolExecFn } from "@cogni/ai-core";
import { isAIMessage, isToolMessage } from "@langchain/core/messages";
import type { RunReceipts } from "./receipts";
import {
	MAX_CHANGED_ITEMS_PER_RUN,
	OPEN_STATUSES,
	RECEIPT_ERROR_MAX_CHARS,
} from "./tools";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Row)
		: undefined;
const sameStatuses = (value: unknown, expected: readonly string[]) =>
	Array.isArray(value) &&
	value.length === expected.length &&
	expected.every((status) => value.includes(status));

export function triageCompletionEvidence(receipts: RunReceipts) {
	const calls = new Map<string, { name: string; args: Row }>();
	const items = new Map<string, Row>();
	const candidates = new Set<string>();
	const writes = new Map<
		string,
		{ expected: Row; fields: string[]; verified: boolean }
	>();
	const chains = new Map<string, { cursor?: string; complete: boolean }>();
	const completed = new Set<string>();
	const failures: string[] = [];
	let failedTools = 0;

	for (const message of receipts.reportMessages) {
		if (isAIMessage(message)) {
			for (const call of message.tool_calls ?? [])
				if (call.id)
					calls.set(call.id, { name: call.name, args: row(call.args) ?? {} });
		}
		if (!isToolMessage(message) || typeof message.content !== "string")
			continue;
		const call = calls.get(message.tool_call_id);
		if (!call) continue;
		let value: Row | undefined;
		try {
			value = row(JSON.parse(message.content));
		} catch {
			/* Not a structured success. */
		}
		if (!value || value.error !== undefined || value.success === false) {
			failedTools++;
			failures.push(
				`${call.name}${typeof call.args.id === "string" ? ` ${call.args.id}` : ""}: ${typeof value?.error === "string" ? value.error.slice(0, RECEIPT_ERROR_MAX_CHARS) : "failed or malformed result"}`,
			);
			continue;
		}
		if (
			call.name === "core__knowledge_read" &&
			typeof call.args.id === "string" &&
			!hasKnowledgeBody(value, call.args.id)
		) {
			failedTools++;
			failures.push(
				`core__knowledge_read ${call.args.id}: required body unavailable`,
			);
		}
		if (
			call.name === "core__work_item_read" &&
			row(value.item)?.id !== call.args.id
		) {
			failedTools++;
			failures.push(
				`core__work_item_read ${String(call.args.id)}: item unavailable`,
			);
		}
		if (call.name === "core__work_item_query" && Array.isArray(value.items)) {
			for (const item of value.items) {
				const candidate = row(item);
				if (
					typeof candidate?.id === "string" &&
					candidate.status !== "done" &&
					candidate.status !== "cancelled"
				)
					candidates.add(candidate.id);
			}
			const allowed = new Set([
				"statuses",
				"scored",
				"sortBy",
				"sortDirection",
				"limit",
				"cursor",
			]);
			const kind = Object.keys(call.args).some((key) => !allowed.has(key))
				? undefined
				: call.args.scored === undefined &&
						sameStatuses(call.args.statuses, ["needs_triage"])
					? "intake"
					: call.args.scored === false &&
							sameStatuses(call.args.statuses, OPEN_STATUSES)
						? "unrankedOpen"
						: undefined;
			if (!kind) continue;
			const { cursor, ...filters } = call.args;
			const signature = JSON.stringify(
				Object.keys(filters)
					.sort()
					.map((key) => [
						key,
						key === "statuses"
							? [...(filters.statuses as string[])].sort()
							: filters[key],
					]),
			);
			const key = `${kind}:${signature}`;
			const position =
				typeof cursor === "string" && cursor ? cursor : undefined;
			let chain = chains.get(key);
			if (position === undefined) {
				chain = { complete: false };
				chains.set(key, chain);
			}
			if (!chain || chain.complete || chain.cursor !== position) continue;
			chain.cursor =
				typeof value.nextCursor === "string" && value.nextCursor
					? value.nextCursor
					: undefined;
			chain.complete = chain.cursor === undefined;
			if (chain.complete) completed.add(kind);
		}
		if (call.name === "core__work_item_read") {
			const item = row(value.item);
			if (typeof item?.id !== "string" || item.id !== call.args.id) continue;
			candidates.add(item.id);
			items.set(item.id, item);
			const write = writes.get(item.id);
			if (write)
				write.verified =
					typeof item.revision === "number" &&
					typeof write.expected.revision === "number" &&
					item.revision >= write.expected.revision &&
					write.fields.every((field) => {
						const project = (v: unknown) =>
							field === "moves" && Array.isArray(v)
								? v
										.map((move) => ({
											metricId: row(move)?.metricId,
											direction: row(move)?.direction,
										}))
										.sort((a, b) =>
											JSON.stringify(a).localeCompare(JSON.stringify(b)),
										)
								: field === "labels" && Array.isArray(v)
									? [...v].sort()
									: field === "scores" && v == null
										? undefined
										: v;
						return isDeepStrictEqual(
							project(item[field]),
							project(write.expected[field]),
						);
					});
		}
		if (
			call.name === "core__work_item_update" &&
			typeof value.id === "string" &&
			value.id === call.args.id &&
			typeof value.revision === "number"
		) {
			const requested = row(call.args.set) ?? {};
			const prior = writes.get(value.id);
			const fields = [
				...new Set([...(prior?.fields ?? []), ...Object.keys(requested)]),
			];
			writes.set(value.id, {
				expected: {
					...prior?.expected,
					...requested,
					revision: value.revision,
				},
				fields,
				verified: false,
			});
			items.set(value.id, value);
		}
	}
	const changedIds = [...writes.keys()];
	const verifiedIds = changedIds.filter((id) => writes.get(id)?.verified);
	const unverifiedIds = changedIds.filter((id) => !writes.get(id)?.verified);
	const unresolved = [...candidates].flatMap((id) => {
		const item = items.get(id);
		if (item && (item.status === "done" || item.status === "cancelled"))
			return [];
		if (!item) return [{ id, reason: "item not read" }];
		if (item.status === "needs_triage")
			return [
				{
					id,
					reason:
						"intake routing still unresolved; read evidence and choose its next gate",
				},
			];
		const missingAxes = [
			"goal",
			"time",
			"unblocks",
			"ease",
			"confidence",
			"agent",
		].filter(
			(axis) =>
				!(
					typeof row(row(item.scores)?.[axis])?.v === "number" &&
					Number(row(row(item.scores)?.[axis])?.v) > 0
				),
		);
		return typeof item.rankScore === "number" && Number.isFinite(item.rankScore)
			? []
			: [
					{
						id,
						reason: `rankScore unavailable; investigate ${missingAxes.length ? missingAxes.join(", ") : "missing or unknown axes"} before rescoring`,
					},
				];
	});
	return {
		changedIds,
		verifiedIds,
		unverifiedIds,
		unresolved,
		failedTools,
		failures,
		queryCoverage: {
			intake: completed.has("intake"),
			unrankedOpen: completed.has("unrankedOpen"),
		},
	};
}

/** True when a knowledge read result carries the complete non-empty body of `id`. */
export function hasKnowledgeBody(value: unknown, id: string): boolean {
	const entries = row(value)?.entries;
	return (
		Array.isArray(entries) &&
		entries.some((entry) => {
			const body = row(entry);
			return (
				body?.id === id &&
				typeof body.content === "string" &&
				body.content.trim() !== ""
			);
		})
	);
}

/** Uses the same authorized read tool, at most once per changed item. No model or write call. */
export async function verifyTriageEffects(
	receipts: RunReceipts,
	readTool: ToolExecFn,
) {
	for (const id of triageCompletionEvidence(receipts).unverifiedIds.slice(
		0,
		MAX_CHANGED_ITEMS_PER_RUN,
	))
		await readTool("core__work_item_read", { id }, `triage-readback-${id}`);
}

/** The model judges work; observed effects and coverage determine the completion claim. */
export function projectTriageAnswer(receipts: RunReceipts): string {
	const evidence = triageCompletionEvidence(receipts);
	const complete =
		evidence.queryCoverage.intake && evidence.queryCoverage.unrankedOpen;
	if (
		!evidence.changedIds.length &&
		!evidence.unresolved.length &&
		complete &&
		!evidence.failedTools
	)
		return "NO_CHANGE";
	return [
		evidence.changedIds.length
			? `UPDATED ${evidence.changedIds.length} item(s): ${evidence.changedIds.join(", ")}.`
			: "No confirmed changes.",
		evidence.verifiedIds.length
			? `Verified by post-write reads: ${evidence.verifiedIds.join(", ")}.`
			: undefined,
		evidence.unverifiedIds.length
			? `UNVERIFIED: ${evidence.unverifiedIds.join(", ")}. Readbacks did not confirm the written fields.`
			: undefined,
		...evidence.unresolved.map(
			({ id, reason }) => `UNRESOLVED ${id}: ${reason}.`,
		),
		!complete
			? `INCOMPLETE_BACKLOG: ${[!evidence.queryCoverage.intake && "needs_triage", !evidence.queryCoverage.unrankedOpen && "unranked open work"].filter(Boolean).join(", ")}.`
			: undefined,
		evidence.failedTools
			? `TOOL_FAILED: ${evidence.failedTools} observed failed attempt(s). ${evidence.failures.join("; ")}. Verified effects are reported separately above; retain these attempts when assessing recovery and waste.`
			: undefined,
	]
		.filter(Boolean)
		.join("\n");
}
