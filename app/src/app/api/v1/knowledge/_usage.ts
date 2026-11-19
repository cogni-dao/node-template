// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/_usage`
 * Purpose: Count one HTTP atom read by an agent (story.0061).
 * Scope: Applies the route wrapper's class rule and hands the read to the container's counter.
 * Invariants:
 * - AGENTS_ONLY: `via: "session"` is a human and is never counted; any other signed-in caller is `external_agent`
 *   (FAIL_CLOSED in wrapRouteHandlerWithLogging).
 * - NEVER_FAILS_THE_ROUTE: a missing or throwing counter is ignored.
 * Side-effects: none beyond `knowledgeReadCounter.count()`
 * Links: https://node-template.cognidao.org/knowledge/knowledge-usage-telemetry
 * @internal
 */

import type { SessionUser } from "@cogni/node-shared";

import { getContainer } from "@/bootstrap/container";

export function countAgentRead(
  sessionUser: SessionUser,
  atomId: string,
  outcome: "ok" | "fail"
): void {
  if (sessionUser.via === "session") return;
  try {
    getContainer().knowledgeReadCounter?.count({
      atomId,
      outcome,
      principalId: sessionUser.id,
      principalClass: "external_agent",
    });
  } catch {
    // NEVER_FAILS_THE_ROUTE
  }
}
