// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/org-connections`
 * Purpose: This node as an ORG: its admin lists the nodes it connected to (with the status each answered, including `suspended`), connects to another node by its origin (`POST`) and
 *   disconnects (`DELETE`) (task.0181). The node signs a short-lived service assertion with its own key and posts it server to server.
 * Scope: The one admin check, then the `@cogni/agent-grants/http` core. Admin acts in Admin (ADMIN_ACTS_IN_ADMIN).
 * Side-effects: IO (HTTPS to the chosen node, service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-fleet-identity
 * @public
 */

import { orgConnectionsRoute } from "@/app/api/v1/admin/_lib/orgs-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = orgConnectionsRoute("admin.org-connections.list", "org_connections.list", "list");
export const POST = orgConnectionsRoute("admin.org-connections.connect", "org_connections.connect", "connect");
export const DELETE = orgConnectionsRoute("admin.org-connections.disconnect", "org_connections.disconnect", "disconnect");
