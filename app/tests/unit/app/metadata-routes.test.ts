// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/metadata-routes.test`
 * Purpose: Guard the two Next metadata routes added in task.5116 — both were 404 on
 *   every node — and the invariant that robots' disallow list cannot drift from the
 *   auth perimeter.
 * Scope: Pure function assertions. Does NOT boot Next or hit the network.
 * Invariants: DISALLOW_TRACKS_THE_PERIMETER; IDENTITY_IS_REPO_SPEC_PROJECTION.
 * Side-effects: none
 * Links: src/app/robots.ts, src/app/manifest.ts, src/shared/routes/private-routes.ts
 * @internal
 */
import { describe, expect, it } from "vitest";
import {
	isPrivateRoute,
	PRIVATE_ROUTE_PREFIXES,
} from "@/shared/routes/private-routes";
import manifest from "@/app/manifest";
import robots from "@/app/robots";

describe("robots.txt", () => {
	it("serves a rule set (the route 404'd on every node before task.5116)", () => {
		const rules = robots().rules;
		expect(Array.isArray(rules)).toBe(false);
		expect(rules).toMatchObject({ userAgent: "*", allow: "/" });
	});

	it("DISALLOW_TRACKS_THE_PERIMETER: every authed prefix is disallowed", () => {
		const disallow = (robots().rules as { disallow: string[] }).disallow;
		for (const route of PRIVATE_ROUTE_PREFIXES) {
			expect(disallow).toContain(route);
		}
		expect(disallow).toContain("/api/");
	});

	it("does not disallow the public landing page", () => {
		const disallow = (robots().rules as { disallow: string[] }).disallow;
		expect(disallow).not.toContain("/");
		expect(isPrivateRoute("/")).toBe(false);
	});
});

describe("manifest.json", () => {
	it("serves an installable manifest (the route 404'd before task.5116)", () => {
		expect(manifest()).toMatchObject({
			start_url: "/",
			display: "standalone",
		});
	});

	it("IDENTITY_IS_REPO_SPEC_PROJECTION: name comes from repo-spec, not a literal", () => {
		const m = manifest();
		// getBrandMark() resolves intent.name; the neutral fallback is "cogni".
		expect(m.name).toBeTruthy();
		expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
	});
});
