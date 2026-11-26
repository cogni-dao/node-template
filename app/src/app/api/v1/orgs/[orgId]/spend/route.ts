// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/[orgId]/spend`
 * Purpose: HUMAN plane, session only. An admin of the org (named by its signed statement) gives a wallet `org:spend` on this node (`POST`) or takes it away (`DELETE`).
 * Scope: Session read and delegation to the `@cogni/agent-grants/http` core. The approver is the session, the org is the path, the wallet is the body. A grant for a wallet that
 *   has not signed in yet is held and becomes a row at that wallet's first sign-in. One `org_events` row per act, in the same transaction.
 * Invariants: ADMINS_FROM_THE_ORG, EVERY_ACT_LOGGED, HUMAN_ROUTES_SESSION_ONLY, NON_DISCLOSING (a person who is no admin gets 404).
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgSpendRoute } from "@/app/_lib/orgs/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = orgSpendRoute("orgs.spend.grant", "grant");
export const DELETE = orgSpendRoute("orgs.spend.remove", "remove");
