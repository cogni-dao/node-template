// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/agent-access-endpoints`
 * Purpose: The human-plane route the "This node's AI" block calls. One constant, so a test can prove the route exists.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY. The block sends the browser session only; the route refuses any Authorization header.
 * Side-effects: none
 * Links: tests/unit/app/agent-access-wiring.test.ts, src/app/api/v1/agent-access/roles/route.ts
 * @internal
 */

export const AGENT_ACCESS_ROLES_PATH = "/api/v1/agent-access/roles" as const;
export const AGENT_ACCESS_ENDPOINTS = { roles: AGENT_ACCESS_ROLES_PATH } as const;
