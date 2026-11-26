// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs`
 * Purpose: HUMAN plane, session only. `GET` lists the org accounts the signed-in person holds a role on, on this node ("Your orgs" in the account menu, and the composer's Bill to).
 * Scope: Session read and delegation to the `@cogni/agent-grants/http` core (task.0181). No person creates an org here: an org connects from its own node (`/api/v1/public/orgs/connect`).
 * Invariants: AN_ORG_IS_A_DAO_AND_ITS_NODE, ADMINS_FROM_THE_ORG (a role is decided from the org's signed statement, never stored), HUMAN_ROUTES_SESSION_ONLY.
 * Side-effects: IO (service-role database read; the org statement fetch, cached at most 5 minutes)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgsMineRoute } from "@/app/_lib/orgs/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = orgsMineRoute();
