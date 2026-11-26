// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/orgs/[orgId]/suspension`
 * Purpose: This node's admin suspends (`suspend: true`) or restores (`false`) an org account, with a reason the org's admins see (task.0181). Runs billed to a suspended account are refused.
 * Scope: The one admin check, then the `@cogni/agent-grants/http` core. Suspend and restore never change the org's admins (NO_TAKEOVER); each is one `org_events` row in the same transaction.
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { adminOrgsRoute } from "@/app/api/v1/admin/_lib/orgs-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = adminOrgsRoute("admin.orgs.set", "orgs.suspension", "set");
