// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]`
 * Purpose: HUMAN plane, session only. `GET` one org account page: its status, balance and, for an admin of the org, the people with a role and the history.
 * Scope: Session read and delegation to the `@cogni/agent-grants/http` core. A person with no role on the org gets one 404 whether it exists or not.
 * Side-effects: IO (service-role database read; the org statement fetch, cached at most 5 minutes)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgViewRoute } from "@/app/_lib/orgs/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = orgViewRoute();
