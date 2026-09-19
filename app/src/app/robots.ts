// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/robots`
 * Purpose: Serve /robots.txt — previously a 404 on every node.
 * Scope: Single default export (Next metadata file convention). Static: it reads no
 *   request state, so it prerenders and can be served from cache.
 * Invariants:
 *   - DISALLOW_TRACKS_THE_PERIMETER: the disallow list is derived from
 *     `PRIVATE_ROUTE_PREFIXES`, the same constant `proxy.ts` enforces. A hand-kept
 *     second copy would drift silently.
 * Side-effects: none
 * Links: src/shared/routes/private-routes.ts, src/proxy.ts, src/app/sitemap.ts
 * @public
 */

import type { MetadataRoute } from "next";
import { PRIVATE_ROUTE_PREFIXES } from "@/shared/routes/private-routes";

export default function robots(): MetadataRoute.Robots {
	return {
		rules: {
			userAgent: "*",
			allow: "/",
			// Authed surfaces plus the API perimeter. Crawlers get redirected or 401'd
			// anyway; saying so up front spends no crawl budget discovering that.
			disallow: [...PRIVATE_ROUTE_PREFIXES, "/api/"],
		},
	};
}
