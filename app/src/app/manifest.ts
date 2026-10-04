// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/manifest`
 * Purpose: Serve /manifest.json — previously a 404 on every node.
 * Scope: Single default export (Next metadata file convention). Static.
 * Invariants:
 *   - IDENTITY_IS_REPO_SPEC_PROJECTION: name and theme colour derive from
 *     `intent.*` via `getBrandMark()`, never hardcoded — the same rule
 *     `opengraph-image.tsx` follows, so a fork customises one file and both the
 *     link preview and the install prompt follow.
 *   - BUILD_SAFE: `getBrandMark()` deliberately avoids `serverEnv()` so this
 *     prerenders without runtime env.
 * Side-effects: reads repo-spec from disk via getBrandMark (cached).
 * Links: src/shared/config/repoSpec.server.ts, src/app/opengraph-image.tsx
 * @public
 */

import type { MetadataRoute } from "next";
import { getBrandMark } from "@/shared/config/repoSpec.server";

/** Neutral tint when a node has not declared `intent.brand.color` (mirrors opengraph-image). */
const FALLBACK_COLOR = "#6366f1";

export default function manifest(): MetadataRoute.Manifest {
	const brand = getBrandMark();

	return {
		name: brand.slug,
		short_name: brand.slug,
		description: brand.hook ?? "A Cogni node — web3 governance, web2 AI.",
		start_url: "/",
		display: "standalone",
		background_color: "#0a0a0a",
		theme_color: brand.color ?? FALLBACK_COLOR,
		icons: [
			{
				src: "/TransparentBrainOnly.png",
				sizes: "any",
				type: "image/png",
			},
		],
	};
}
