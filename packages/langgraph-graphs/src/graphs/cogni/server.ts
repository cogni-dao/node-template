import { NODE_LANGGRAPH_CATALOG } from "../../catalog";
import { makeServerGraph } from "../../runtime/core/make-server-graph";

const assignment = NODE_LANGGRAPH_CATALOG.cogni;
/** Same program as the app; Studio still uses development transport and stub tools. */
export const cogni = await makeServerGraph({
	name: "cogni",
	createGraph: (opts) =>
		assignment.graphFactory({ ...opts, systemPrompt: assignment.systemPrompt }),
	toolIds: assignment.toolIds,
	program: assignment.program,
});
