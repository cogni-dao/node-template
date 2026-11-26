// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent-access/mine`
 * Purpose: HUMAN plane, session only. A signed-in person lists the AIs that may act on THEIR OWN account (GET), turns one On (POST: an outside AI's ask by its
 *   one-time link token, or this node's own AI directly) and turns one Off or dismisses an ask (DELETE), by clicking on `/profile`.
 * Scope: HTTP validation and the session read. Every decision is the package's one gate (`canApprove`), which asks the database whether the signed-in person owns
 *   the account. The approver and the account are never in the body: the approver is the session, the account is the one that person owns.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header (a bearer agent, an admin with a key) is 403 `human_session_required`, before any read or write.
 *   - ONE_GATE / APPROVER_FOLLOWS_RESOURCE: the account owner alone decides an account row; a node-admin session adds nothing and takes nothing away.
 *   - PROFILE_NEVER_SHOWS_NODE_ROWS: GET returns this person's account rows only.
 *   - SCOPE_KIND_PICKS_THE_PLANE: a direct On names a scope this node declares with kind `account`; any other scope is 400 `invalid_scope` before anything is read or written.
 *   - NON_DISCLOSING: a token that is wrong-kind, used, expired or unknown, and a row on someone else's account, answer `changed: false`, never a reason.
 *   - HUMAN_SURFACE_TOKENLESS: the token travels in the body only (the page read it from the link fragment); the response never carries one.
 * Side-effects: IO (service-role database read and write), logs `agent_role.*`
 * Links: packages/agent-grants (canApprove, approveAccountAsk), https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import { mineRoute } from "@/app/_lib/agent-access/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = mineRoute("agent.mine.list", "list", false);
export const POST = mineRoute("agent.mine.on", "on", true);
export const DELETE = mineRoute("agent.mine.off", "off", true);
