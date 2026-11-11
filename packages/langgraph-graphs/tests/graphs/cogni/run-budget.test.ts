// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Long runs end in a handoff, not a crash (story.0035). Past a share of the run's own recursionLimit, the
 * harness tells every model call to write and hand off. A fake model that keeps reading until told so proves it.
 */
import {
	BaseChatModel,
	type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCogniProgram } from "../../../src/graphs/cogni/graph";

/** Reads until `doneAfter` calls, or until the system prompt carries the run-budget notice; then it answers. */
class ReadUntilToldModel extends BaseChatModel {
	readonly warnedAt: number[] = [];
	calls = 0;
	constructor(
		private readonly doneAfter = Number.POSITIVE_INFINITY,
		params: BaseChatModelParams = {},
	) {
		super(params);
	}
	_llmType() {
		return "read-until-told";
	}
	bindTools() {
		return this as never;
	}
	async _generate(messages: BaseMessage[]): Promise<ChatResult> {
		this.calls += 1;
		const system = messages
			.filter((m) => m.getType() === "system")
			.map((m) => m.text)
			.join("\n");
		const warned = system.includes("Run budget:");
		if (warned) this.warnedAt.push(this.calls);
		const message = warned || this.calls > this.doneAfter
			? new AIMessage("Handoff: read items 1..n; nothing remains unread that I verified.")
			: new AIMessage({
					content: "",
					tool_calls: [{ id: `c${this.calls}`, name: "read_item", args: { n: this.calls }, type: "tool_call" }],
				});
		return { generations: [{ text: String(message.content), message }] };
	}
}

const readItem = tool(async ({ n }) => JSON.stringify({ item: n }), {
	name: "read_item",
	description: "Read one item.",
	schema: z.object({ n: z.number() }),
});

describe("harness run budget", () => {
	it("tells the model to hand off before the step limit, so the run finishes instead of crashing", async () => {
		const llm = new ReadUntilToldModel();
		const graph = createCogniProgram({
			llm: llm as never,
			tools: [readItem] as never,
			disableCheckpointer: true,
		} as never);
		const result = await graph.invoke(
			{ messages: [{ role: "user", content: "read everything" }] },
			{ recursionLimit: 60 },
		);
		const last = result.messages.at(-1);
		expect(String(last?.content)).toContain("Handoff");
		expect(llm.warnedAt).toHaveLength(1);
		expect(llm.calls).toBeGreaterThan(3);
	});

	it("adds nothing to a run that finishes well inside its limit", async () => {
		const llm = new ReadUntilToldModel(3);
		const graph = createCogniProgram({
			llm: llm as never,
			tools: [readItem] as never,
			disableCheckpointer: true,
		} as never);
		await graph.invoke(
			{ messages: [{ role: "user", content: "read three" }] },
			{ recursionLimit: 100 },
		);
		expect(llm.calls).toBe(4);
		expect(llm.warnedAt).toHaveLength(0);
	});
});
