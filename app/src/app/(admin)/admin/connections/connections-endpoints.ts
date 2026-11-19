// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connections/connections-endpoints`
 * Purpose: The admin-area route the "Connections" page calls (GET lists the configured providers, POST connects or disconnects). One object, so a test can prove the route exists.
 * Invariants: ONE_ADMIN_CHECK. The page sends the browser session; the route runs the same admin check for a session or a bearer.
 * Side-effects: none
 * Links: src/app/api/v1/admin/connections/route.ts
 * @internal
 */

export const CONNECTIONS_PATH = "/api/v1/admin/connections" as const;
export const CONNECTIONS_ENDPOINTS = { connections: CONNECTIONS_PATH } as const;
