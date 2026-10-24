// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/agent-grants/node-agent-grants`
 * Purpose: This node's agent-grant wiring — the ONE declaration of the scopes
 *   an agent may request, the app-role tenant transaction the
 *   `@cogni-dao/agent-grants` operations run in, and the shared non-disclosing
 *   denial response.
 * Scope: Node-local glue for thin routes. No authorization logic lives here.
 * Invariants:
 *   - NODE_DECLARED_SCOPES: NODE_AGENT_SCOPES is the only scope source; the
 *     package rejects anything else at request and approval time.
 *   - NON_DISCLOSING_DENIAL: every authorization denial is the same 404 body.
 * Side-effects: IO (Postgres transaction via app-role db)
 * Links: story.5115, packages/agent-grants
 * @public
 */

import type { AgentGrantsDb } from "@cogni-dao/agent-grants";
import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import { NextResponse } from "next/server";
import { resolveAppDb } from "@/bootstrap/container";

export const ACCOUNT_READ_SCOPE = "account:read";

/** Every scope an agent may request on this node. */
export const NODE_AGENT_SCOPES: readonly string[] = [ACCOUNT_READ_SCOPE];

/** Run `fn` in an app-role (RLS-enforced) transaction as `principalId`. */
export function withPrincipalTx<T>(
  principalId: string,
  fn: (tx: AgentGrantsDb) => Promise<T>
): Promise<T> {
  return withTenantScope(resolveAppDb(), userActor(toUserId(principalId)), fn);
}

export function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
