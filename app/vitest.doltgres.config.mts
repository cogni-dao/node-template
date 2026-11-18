// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Isolated real-Doltgres acceptance lane; never shares the Postgres setup. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { BaseSequencer } from "vitest/node";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Files run in parallel on a few workers, and vitest starts them biggest-source-first. The files that
// mostly WAIT (a real CLI deadline, pg_sleep, a 15625-row seed) are small or mid-sized in source, so by
// default they start last and set the lane's length. Start the longest-running files first (task.0138).
// A stale name here only costs the ordering, never a test.
const LONGEST_FIRST = [
	"doltgres-admission-deadline.int.test.ts",
	"doltgres-work-items-rank.int.test.ts",
	"doltgres-work-items-producers.int.test.ts",
	"doltgres-work-items-settlement.int.test.ts",
	"doltgres-work-items-core.int.test.ts",
	"doltgres-knowledge-browse.int.test.ts",
	"doltgres-admission.int.test.ts",
	"doltgres-usewhen-patch.int.test.ts",
];
class LongestFirstSequencer extends BaseSequencer {
	async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
		const rank = (spec: unknown) => {
			const id = String((spec as { moduleId?: string }).moduleId ?? spec);
			const at = LONGEST_FIRST.findIndex((name) => id.endsWith(`/${name}`));
			return at < 0 ? LONGEST_FIRST.length : at;
		};
		return [...files].sort((a, b) => rank(a) - rank(b));
	}
}

export default defineConfig({
	root: __dirname,
	plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
	test: {
		include: ["tests/component/db/doltgres-*.int.test.ts"],
		environment: "node",
		setupFiles: ["./tests/setup.ts"],
		sequence: { concurrent: false, sequencer: LongestFirstSequencer },
		testTimeout: 120_000,
		hookTimeout: 180_000,
	},
	resolve: {
		alias: {
			"@tests": path.resolve(__dirname, "./tests"),
		},
	},
});
