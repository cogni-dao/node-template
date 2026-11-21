import { makeServerGraph } from "../../runtime/core/make-server-graph";
import { createMissionResearchGraph } from "./graph";
import { MISSION_RESEARCH_TOOL_IDS } from "./tools";
export const missionResearch = await makeServerGraph({
	name: "mission-research",
	createGraph: createMissionResearchGraph,
	toolIds: MISSION_RESEARCH_TOOL_IDS,
	program: "mission-research",
});
