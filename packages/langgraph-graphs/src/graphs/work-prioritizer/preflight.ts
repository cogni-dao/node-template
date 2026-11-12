// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { StructuredToolInterface } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { authorizedReadMessages } from "../cogni/authorized-read-messages";
import { REQUIRED_GUIDANCE_IDS } from "./prompts";

/** Fixed prerequisites use native state and the same authorized, instrumented read tools. */
export function createTriagePreflight(
	tools: readonly StructuredToolInterface[],
) {
	return createMiddleware({
		name: "TriageReadPreflight",
		beforeAgent: async () => ({
			messages: await authorizedReadMessages(tools, [
				...REQUIRED_GUIDANCE_IDS.map((id) => ({
					name: "core__knowledge_read",
					args: { id },
				})),
				{ name: "core__goal_list", args: {} },
				{ name: "core__goal_progress", args: { history: "none" } },
			]),
		}),
	});
}
