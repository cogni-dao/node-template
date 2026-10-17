// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/routes/private-routes`
 * Purpose: The single list of route prefixes that require authentication.
 * Scope: Pure data + one predicate. No IO, no framework imports — so both the edge
 *   middleware and the static `robots.ts` metadata route can consume it.
 * Invariants:
 *   - ONE_LIST_FOR_PERIMETER_AND_ROBOTS: `proxy.ts` redirects these when signed out and
 *     `app/robots.ts` disallows the same prefixes. Two copies would drift, and the drift
 *     is silent — a crawler indexing an authed route only shows up in search results.
 * Side-effects: none (pure)
 * Links: src/proxy.ts, src/app/robots.ts
 * @public
 */

/** Route prefixes that require authentication — signed-out visitors are redirected to `/`. */
export const PRIVATE_ROUTE_PREFIXES = [
	"/chat",
	"/dashboard",
	"/profile",
	"/credits",
	"/gov",
	"/knowledge",
	"/schedules",
	"/setup",
	"/work",
	"/activity",
	"/admin",
] as const;

/** True when `pathname` is, or is nested under, a private route prefix. */
export function isPrivateRoute(pathname: string): boolean {
	return PRIVATE_ROUTE_PREFIXES.some(
		(route) => pathname === route || pathname.startsWith(`${route}/`),
	);
}
