// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** The harness adds no cap of its own: the index owner bounds it (guidance-routing-design). */
import { tool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createNodeOperatorGraph } from "../../../src/graphs/node-operator/graph";

const t = (name: string) =>
	tool(async () => "{}", { name, description: name, schema: z.object({}).passthrough() });

describe("Cogni guidance index has one owner", () => {
	it("builds with a 60-entry hub index instead of failing on a harness-only cap", () => {
		const governingIndex = Array.from({ length: 60 }, (_, i) => ({
			id: `entry-${i}`,
			useWhen: "a reader decision ".repeat(8),
		}));
		const build = () =>
			createNodeOperatorGraph({
				llm: new FakeListChatModel({ responses: ["x"] }) as never,
				tools: ["core__knowledge_read", "core__goal_list"].map(t) as never,
				program: "cogni",
				sourceContext: {
					nodeId: "n",
					origin: "https://x",
					mission: { content: "m", sourceRef: "s", buildSha: null },
					governingIndex,
				},
			} as never);
		expect(build).not.toThrow();
	});
});
