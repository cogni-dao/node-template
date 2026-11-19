// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connected-orgs/connected-orgs-endpoints`
 * Purpose: The admin-area routes the "Connected orgs" page calls. One place, so a test can prove each route exists.
 * Invariants: ONE_ADMIN_CHECK. The page sends the browser session; each route runs the same admin check for a session or a bearer.
 * Side-effects: none
 * Links: src/app/api/v1/admin/connected-orgs/route.ts
 * @internal
 */

export const CONNECTED_ORGS_PATH = "/api/v1/admin/connected-orgs" as const;
export const allowancePath = (orgUserId: string): string => `${CONNECTED_ORGS_PATH}/${encodeURIComponent(orgUserId)}/allowance`;
export const suspensionPath = (orgUserId: string): string => `${CONNECTED_ORGS_PATH}/${encodeURIComponent(orgUserId)}/suspension`;
