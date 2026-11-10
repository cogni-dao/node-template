import { NODE_LANGGRAPH_CATALOG } from "../../catalog";
import { makeCogniGraph } from "../../runtime/cogni/make-cogni-graph";

const assignment = NODE_LANGGRAPH_CATALOG.cogni;
export const cogniGraph = makeCogniGraph({
	name: "cogni",
	createGraph: (opts) =>
		assignment.graphFactory({ ...opts, systemPrompt: assignment.systemPrompt }),
	toolIds: assignment.toolIds,
	program: assignment.program,
});
