import { makeCogniGraph } from "../../runtime/cogni/make-cogni-graph";
import { createMissionResearchGraph } from "./graph";
import { MISSION_RESEARCH_TOOL_IDS } from "./tools";
export const missionResearch = makeCogniGraph({
	name: "mission-research",
	createGraph: createMissionResearchGraph,
	toolIds: MISSION_RESEARCH_TOOL_IDS,
	program: "mission-research",
});
