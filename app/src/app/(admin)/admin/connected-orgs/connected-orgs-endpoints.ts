// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connected-orgs/connected-orgs-endpoints`
 * Purpose: The admin-area route the "Connected orgs" page calls. One object, so a test can prove the route exists. The package's `ConnectedOrgsSection` appends `/{orgUserId}/allowance`
 *   and `/suspension` to `list`.
 * Invariants: ONE_ADMIN_CHECK. The page sends the browser session; each route runs the same admin check for a session or a bearer.
 * Side-effects: none
 * Links: src/app/api/v1/admin/connected-orgs/route.ts
 * @internal
 */

export const CONNECTED_ORGS_PATH = "/api/v1/admin/connected-orgs" as const;
export const CONNECTED_ORGS_ENDPOINTS = { list: CONNECTED_ORGS_PATH } as const;
