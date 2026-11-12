// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import {
	ScheduleManageInputSchema,
	WorkItemQueryInputSchema,
} from "@cogni/ai-tools";
import {
	DynamicStructuredTool,
	type StructuredToolInterface,
} from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { authorizedReadMessages } from "../cogni/authorized-read-messages";
import { OPEN_STATUSES } from "../work-prioritizer/tools";

export interface WorkflowGuidance {
	readonly graphId: string;
	readonly guidanceId: string;
}
const lookup = z.object({
	purpose: z
		.string()
		.min(1)
		.refine((value) => value.trim().length > 0),
});
const schedules = z.object({ schedules: z.array(z.unknown()) });
// A narrowed search is useful evidence, but cannot replace the open-work sample.
const backlogQuery = WorkItemQueryInputSchema.pick({
	statuses: true,
	limit: true,
}).strict();
const contextReads = [
	{
		name: "core__goal_list",
		args: {},
		schema: z.object({ goals: z.array(z.unknown()) }),
	},
	{
		name: "core__goal_progress",
		args: { history: "none" },
		schema: z.object({
			goals: z.array(z.unknown()),
			asOf: z.string(),
			environment: z.string(),
		}),
	},
	{
		name: "core__work_item_query",
		args: { statuses: [...OPEN_STATUSES], limit: 50 },
		schema: z.object({ items: z.array(z.unknown()) }),
	},
];
const knowledge = z.object({
	mode: z.literal("get"),
	partial: z.literal(false).optional(),
	truncated: z.literal(false).optional(),
	entries: z.array(
		z.object({
			id: z.string(),
			content: z.string().trim().min(1),
			partial: z.literal(false).optional(),
			truncated: z.literal(false).optional(),
		}),
	),
});

/** Only actual host tool receipts populate this per-run state; messages never do. */
export class NodeOperatorReceipts {
	readonly contextAttempts = new Set<string>();
	readonly contextRead = new Set<string>();
	readonly purposes = new Set<string>();
	readonly attemptedGuidance = new Set<string>();
	readonly readGuidance = new Set<string>();
	observe(
		name: string,
		args: unknown,
		result: { ok: boolean; value?: unknown },
	) {
		const expected = contextReads.find((request) => request.name === name);
		const query = backlogQuery.safeParse(args);
		const canonical =
			name !== "core__work_item_query" ||
			(query.success &&
				query.data.limit === 50 &&
				query.data.statuses?.length === OPEN_STATUSES.length &&
				OPEN_STATUSES.every((status) => query.data.statuses?.includes(status)));
		if (expected && canonical) {
			this.contextAttempts.add(name);
			if (result.ok && expected.schema.safeParse(result.value).success)
				this.contextRead.add(name);
		}
		if (name === "core__schedule_list" && result.ok) {
			const input = lookup.safeParse(args);
			if (input.success && schedules.safeParse(result.value).success)
				this.purposes.add(input.data.purpose);
		}
		if (name === "core__knowledge_read") {
			const input = z.object({ id: z.string() }).safeParse(args);
			if (!input.success) return;
			this.attemptedGuidance.add(input.data.id);
			const output = result.ok ? knowledge.safeParse(result.value) : undefined;
			if (
				output?.success &&
				output.data.entries.some((entry) => entry.id === input.data.id)
			)
				this.readGuidance.add(input.data.id);
		}
	}
}

/** A purpose lookup starts coordination. Supply catalog cards before its next decision. */
export function createWorkflowGuidancePreflight(
	receipts: NodeOperatorReceipts,
	tools: readonly StructuredToolInterface[],
	workflows: readonly WorkflowGuidance[],
) {
	return createMiddleware({
		name: "NodeWorkflowGuidance",
		beforeModel: async () => {
			if (!receipts.purposes.size) return;
			const ids = [
				...new Set(workflows.map((workflow) => workflow.guidanceId)),
			].filter((id) => !receipts.attemptedGuidance.has(id));
			const context = contextReads
				.filter((request) => !receipts.contextAttempts.has(request.name))
				.map(({ name, args }) => ({ name, args }));
			if (!ids.length && !context.length) return;
			// Runtime capability denial can happen before host observeTool is called.
			// Record attempts here; successful-read authority still comes only from the host.
			for (const id of ids) receipts.attemptedGuidance.add(id);
			for (const request of context) receipts.contextAttempts.add(request.name);
			return {
				messages: await authorizedReadMessages(tools, [
					...context,
					...ids.map((id) => ({ name: "core__knowledge_read", args: { id } })),
				]),
			};
		},
	});
}

/** Preserve the host writer/schema/authority; refuse ungrounded creation before invoking it. */
export function createNodeScheduleGuard(
	receipts: NodeOperatorReceipts,
	writer: StructuredToolInterface,
	workflows: readonly WorkflowGuidance[],
) {
	return new DynamicStructuredTool({
		name: writer.name,
		description: writer.description,
		schema: ScheduleManageInputSchema,
		func: async (input, _manager, config) => {
			if (input.action === "create") {
				if (
					!contextReads.every((request) =>
						receipts.contextRead.has(request.name),
					)
				)
					return "guard_rejected: current goals, KPI status or open-work evidence is unavailable; read the failed source before creating a job";
				const purpose =
					input.purpose ??
					(input.input?._meta as { purpose?: unknown } | undefined)?.purpose;
				if (typeof purpose !== "string" || !receipts.purposes.has(purpose))
					return "guard_rejected: read core__schedule_list with this exact purpose before creating a job";
				const guide = workflows.find(
					(workflow) => workflow.graphId === input.graphId,
				)?.guidanceId;
				if (!guide || !receipts.readGuidance.has(guide))
					return "guard_rejected: selected workflow guidance is unavailable or unread; read its catalog-declared full graph card before creating a job";
			}
			return writer.invoke(input, config);
		},
	});
}
