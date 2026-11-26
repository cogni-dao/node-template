// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/orgs`
 * Purpose: This node's admin lists every org account on this node (name, status, reason) for `/admin` org accounts (task.0181).
 * Scope: The one admin check, then the `@cogni/agent-grants/http` core. Admin acts in Admin (ADMIN_ACTS_IN_ADMIN).
 * Side-effects: IO (service-role database read)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { adminOrgsRoute } from "@/app/api/v1/admin/_lib/orgs-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = adminOrgsRoute("admin.orgs.list", "orgs.list", "list");
