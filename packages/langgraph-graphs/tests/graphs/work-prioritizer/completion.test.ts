// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { StructuredToolInterface } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import {
	projectTriageAnswer,
	triageCompletionEvidence,
	verifyTriageEffects,
} from "../../../src/graphs/work-prioritizer/completion";
import { RunReceipts } from "../../../src/graphs/work-prioritizer/receipts";
import { OPEN_STATUSES } from "../../../src/graphs/work-prioritizer/tools";
import { createTriageGuard } from "../../../src/graphs/work-prioritizer/triage-guard";

const item = {
	id: "task.1",
	type: "task",
	status: "needs_implement",
	revision: 8,
	labels: ["test-fixture"],
	scores: { goal: { v: 3 }, agent: { v: 0 } },
};
const queries = (receipts: RunReceipts) => {
	receipts.recordTool(
		"core__work_item_query",
		{ statuses: ["needs_triage"] },
		{ items: [] },
	);
	receipts.recordTool(
		"core__work_item_query",
		{ statuses: [...OPEN_STATUSES], scored: false },
		{ items: [] },
	);
};
const write = (receipts: RunReceipts) =>
	receipts.recordTool(
		"core__work_item_update",
		{ id: item.id, set: { status: item.status } },
		item,
	);

describe("triage completion uses observed facts", () => {
	it("cannot call an unqueried backlog unchanged", () => {
		expect(
			projectTriageAnswer(new RunReceipts("https://node.example")),
		).toContain("INCOMPLETE_BACKLOG");
	});
	it("requires both intake and unranked open coverage before a quiet success", () => {
		const receipts = new RunReceipts("https://node.example");
		queries(receipts);
		expect(projectTriageAnswer(receipts)).toBe("NO_CHANGE");
	});
	it("does not mistake an empty page with a cursor or changed filters for exhaustion", () => {
		const receipts = new RunReceipts("https://node.example");
		receipts.recordTool(
			"core__work_item_query",
			{ statuses: ["needs_triage"], limit: 1 },
			{ items: [], nextCursor: "page2" },
		);
		receipts.recordTool(
			"core__work_item_query",
			{ statuses: ["needs_triage"], limit: 2, cursor: "page2" },
			{ items: [] },
		);
		expect(triageCompletionEvidence(receipts).queryCoverage.intake).toBe(false);
		receipts.recordTool(
			"core__work_item_query",
			{ statuses: ["needs_triage"], limit: 1, cursor: "page2" },
			{ items: [] },
		);
		expect(triageCompletionEvidence(receipts).queryCoverage.intake).toBe(true);
	});
	it("keeps unknown ranks unresolved even when a repeat makes no writes", () => {
		const receipts = new RunReceipts("https://node.example");
		queries(receipts);
		receipts.recordTool("core__work_item_read", { id: item.id }, { item });
		expect(projectTriageAnswer(receipts)).toContain("UNRESOLVED task.1");
		expect(projectTriageAnswer(receipts)).not.toBe("NO_CHANGE");
	});
	it("an earlier read and a successful update are not post-write verification", () => {
		const receipts = new RunReceipts("https://node.example");
		receipts.recordTool(
			"core__work_item_read",
			{ id: item.id },
			{ item: { ...item, revision: 7 } },
		);
		write(receipts);
		expect(triageCompletionEvidence(receipts).unverifiedIds).toEqual([item.id]);
		receipts.recordTool(
			"core__work_item_read",
			{ id: item.id },
			{ item: { ...item, status: "needs_research" } },
		);
		expect(triageCompletionEvidence(receipts).verifiedIds).toEqual([]);
		receipts.recordTool("core__work_item_read", { id: item.id }, { item });
		expect(triageCompletionEvidence(receipts).verifiedIds).toEqual([item.id]);
	});
	it("verifies each changed item once through the supplied read tool", async () => {
		const receipts = new RunReceipts("https://node.example");
		write(receipts);
		const calls: string[] = [];
		await verifyTriageEffects(receipts, async (name, args, id) => {
			calls.push(name);
			receipts.recordTool(name, args, { item }, id);
			return { ok: true, value: { item } };
		});
		await verifyTriageEffects(receipts, async () => {
			throw new Error("unnecessary second read");
		});
		expect(calls).toEqual(["core__work_item_read"]);
		expect(projectTriageAnswer(receipts)).toContain(
			"Verified by post-write reads: task.1",
		);
	});
	it("a failed tool result cannot become a quiet success", () => {
		const receipts = new RunReceipts("https://node.example");
		queries(receipts);
		receipts.recordTool(
			"core__work_item_update",
			{ id: item.id },
			{ error: "revision_conflict" },
		);
		expect(triageCompletionEvidence(receipts).changedIds).toEqual([]);
		expect(projectTriageAnswer(receipts)).toContain("TOOL_FAILED");
	});
	it("ranked intake still needs a routing judgment", () => {
		const receipts = new RunReceipts("https://node.example");
		queries(receipts);
		receipts.recordTool(
			"core__work_item_read",
			{ id: item.id },
			{ item: { ...item, status: "needs_triage", rankScore: 2 } },
		);
		expect(projectTriageAnswer(receipts)).toContain(
			"intake routing still unresolved",
		);
		expect(projectTriageAnswer(receipts)).not.toBe("NO_CHANGE");
	});
	it("retains every intended field across multiple writes", () => {
		const receipts = new RunReceipts("https://node.example");
		write(receipts);
		receipts.recordTool(
			"core__work_item_update",
			{ id: item.id, set: { labels: ["test-fixture", "goal:known"] } },
			{ ...item, labels: ["test-fixture", "goal:known"], revision: 9 },
		);
		receipts.recordTool(
			"core__work_item_read",
			{ id: item.id },
			{
				item: {
					...item,
					status: "needs_triage",
					labels: ["goal:known", "test-fixture"],
					revision: 10,
				},
			},
		);
		expect(triageCompletionEvidence(receipts).verifiedIds).toEqual([]);
	});
	it("compares the requested effect rather than trusting its response", () => {
		const receipts = new RunReceipts("https://node.example");
		receipts.recordTool(
			"core__work_item_update",
			{ id: item.id, set: { status: "needs_design" } },
			item,
		);
		receipts.recordTool("core__work_item_read", { id: item.id }, { item });
		expect(triageCompletionEvidence(receipts).verifiedIds).toEqual([]);
	});
	it("does not report closed rows from an overly broad query as unresolved open work", () => {
		const receipts = new RunReceipts("https://node.example");
		queries(receipts);
		receipts.recordTool(
			"core__work_item_query",
			{},
			{ items: [{ id: item.id, status: "cancelled" }] },
		);
		expect(projectTriageAnswer(receipts)).toBe("NO_CHANGE");
	});
	it("preserves missing body, missing item and guard refusal facts", async () => {
		const receipts = new RunReceipts("https://node.example");
		queries(receipts);
		receipts.recordTool(
			"core__knowledge_read",
			{ id: "agent-human-boundary" },
			{ mode: "get", entries: [] },
		);
		receipts.recordTool(
			"core__work_item_read",
			{ id: item.id },
			{ item: null },
		);
		const writer = {
			name: "core__work_item_update",
			description: "test writer",
			invoke: async () => {
				throw new Error("must not write");
			},
		} as unknown as StructuredToolInterface;
		const guard = createTriageGuard(receipts, writer, ["agent-human-boundary"]);
		await guard.invoke({
			id: item.id,
			expectedRevision: 7,
			reason: "test change",
			set: { status: "needs_design" },
		});
		const answer = projectTriageAnswer(receipts);
		expect(answer).toContain("required body unavailable");
		expect(answer).toContain("item unavailable");
		expect(answer).toContain("guard_rejected: guidance");
		expect(answer).not.toBe("NO_CHANGE");
	});
});
