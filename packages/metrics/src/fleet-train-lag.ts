// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { z } from "zod";
import type { MetricCalculator } from "./contracts.js";
import {
	FLEET_TRAIN_MAX_CONSUMERS,
	GITHUB_REPO_PATTERN,
	MANIFEST_PATH_PATTERN,
	readFleetTrainLag,
} from "./fleet-sources.js";

const ghRepo = z.string().regex(GITHUB_REPO_PATTERN);
const trainLagParams = z.strictObject({
	publisher: ghRepo,
	members: z
		.array(
			z.strictObject({
				name: z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/),
				tagPrefix: z.string().regex(/^[a-z0-9-]+-v$/),
			}),
		)
		.min(1)
		.max(10),
	consumers: z
		.array(
			z.strictObject({
				repo: ghRepo,
				manifestPath: z.string().regex(MANIFEST_PATH_PATTERN),
			}),
		)
		.min(1)
		.max(FLEET_TRAIN_MAX_CONSUMERS),
	graceHours: z.number().int().min(0).max(168),
});

/** The shared fleet descriptor; consumers supply it to their existing metric engine. */
export function createFleetTrainLagCalculator(): MetricCalculator {
	return {
		id: "fleet.train-lag@1",
		unit: "nodes",
		display: "volume",
		paramsSchema: trainLagParams,
		budget: {
			timeoutMs: 30000,
			maxSourceCalls: 1,
			maxRows: 100,
			maxResponseBytes: 1_048_576,
		},
		compute: async (params, ctx) => {
			const p = trainLagParams.parse(params);
			return ctx.read((signal, limits) =>
				readFleetTrainLag(p, new Date(ctx.window.end), signal, limits),
			);
		},
	};
}
