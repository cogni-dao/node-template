// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/orgs/org-endpoints`
 * Purpose: The human-plane routes the org pages call (`/orgs`, `/orgs/[id]`, and the org rows on `/admin`). One constant, so a test can prove the routes exist.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY. The pages send the browser session only; the routes decide every right (an owner, an admin, the node admin).
 * Side-effects: none
 * Links: src/app/api/v1/orgs/route.ts
 * @internal
 */

export const ORG_ENDPOINTS = {
  orgs: "/api/v1/orgs",
  adminOrgs: "/api/v1/admin/orgs",
} as const;
