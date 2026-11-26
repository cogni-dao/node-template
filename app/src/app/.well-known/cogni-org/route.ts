// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/.well-known/cogni-org`
 * Purpose: This node's org statement (task.0181): a short-lived JWT, signed with this node's key, naming its node id, origin, DAO, admins (the repo-spec approvers), enabled services and
 *   the repo-spec commit. A node an org connects to pulls it here and verifies it against `/.well-known/jwks.json`.
 * Scope: Single GET handler. Public, no auth. The package signs; this route only serves it.
 * Invariants: UNSET_IS_404 (no signing key or no public origin: this node is not an org), NEVER_CACHED (the statement lives at most 10 minutes and its version only rises), NO_PRIVATE_MEMBER.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { NextResponse } from "next/server";
import { httpDeps } from "@/app/_lib/agent-access/respond";
import { getContainer } from "@/bootstrap/container";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const container = getContainer();
  // A failure to sign is logged (one registered error line, never the facts or a key) and answered with the same 404 as "not an org".
  const statement = await container.agentAuthority.orgStatement().catch((error: unknown) => {
    httpDeps(container.log).onUnavailable("orgs.statement", error);
    return null;
  });
  if (!statement) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  return new NextResponse(statement, { headers: { "content-type": "application/jwt", "cache-control": "no-store" } });
}
