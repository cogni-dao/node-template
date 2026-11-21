// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/tsup.config`
 * Purpose: Build configuration for graph-execution-host package.
 * Scope: Build tooling only. Does not contain runtime code.
 * Invariants: Output must be ESM with sourcemaps.
 * Side-effects: IO
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/packages-architecture.md
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig([
	{
		entry: ["src/index.ts"],
		format: ["esm"],
		dts: false,
		outDir: "dist/bundled", // Keep published entries separate from tsc -b output.
		clean: false,
		sourcemap: true,
		// This package transitively reaches node:crypto (the trace-scrubbing helpers
		// hash content), so it builds for node. Under "neutral" esbuild cannot
		// resolve the builtin once the workspace closure is bundled:
		// `Could not resolve "crypto"`. `platform: "node"` also keeps builtins
		// external in the tarball, which is what a consumer wants.
		platform: "node",
		// Bundle the workspace closure so the published tarball is a dependency
		// leaf: a consumer installs one artifact, not a graph of unpublished
		// @cogni/* packages. Everything reached is pure — ai-core and
		// graph-execution-core are types and constants, and the only node-shared
		// imports are its two pure subpaths.
		noExternal: [/^@cogni\//],
	},
	{
		entry: ["src/index.ts"],
		format: ["esm"],
		outDir: "dist/bundled",
		dts: {
			only: true,
			resolve: true,
			compilerOptions: {
				composite: false,
				incremental: false,
				rootDir: "..",
				baseUrl: ".",
				paths: {
					"@cogni/graph-execution-core": [
						"../graph-execution-core/src/index.ts",
					],
					"@cogni/node-shared/*": ["../node-shared/src/*"],
				},
			},
		},
		// Do not feed Zod JavaScript to the declaration bundler. Its types are unused.
		external: ["zod"],
	},
]);

export default tsupConfig;
